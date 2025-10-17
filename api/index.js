import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch"; // o global fetch si usas Node 18+
import { createClient } from "@supabase/supabase-js";

// 📱 Variables de Meta
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const tempToken = process.env.META_TEMP_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

// Supabase
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE
);

async function obtenerTokenLargo() {
  const url = `https://graph.facebook.com/v17.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tempToken}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    console.log("Token de 60 días:", data.access_token);
    console.log("Expira en segundos:", data.expires_in);
    return data.access_token;
  } catch (error) {
    console.error("Error obteniendo token:", error);
  }
}

async function main() {
  const ACCESS_TOKEN = await obtenerTokenLargo();
  if (!ACCESS_TOKEN) {
    console.error("No se pudo obtener el token de WhatsApp Cloud.");
    return;
  }

  const app = express();
  app.use(bodyParser.json());

  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" },
  });

  app.use(
    cors({
      origin: "http://localhost:5173",
      methods: ["GET", "POST"],
    })
  );

  // 📩 Webhook para recibir mensajes
  app.post("/webhook", async (req, res) => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0]?.value;

      if (changes?.messages) {
        const message = changes.messages[0];
        const from = message.from;
        const text = message.text?.body || "";

        console.log("Mensaje recibido:", from, text);

        // 🔹 Verificar si ya existe chat
        let { data: chat, error } = await supabase
          .from("chats")
          .select("*")
          .eq("wa_id", from)
          .single();

        if (!chat) {
          // 🔹 Crear chat nuevo si no existe
          const { data: newChat } = await supabase
            .from("chats")
            .insert([{ wa_id: from }])
            .select("*")
            .single();
          chat = newChat;
        }

        // 🔹 Guardar mensaje en messages
        await supabase.from("messages").insert([
          {
            wa_id: from,
            direction: "incoming",
            message: text,
            chat_id: chat.id
          },
        ]);

        console.log("💾 Mensaje recibido guardado en Supabase");

        // Emitir al frontend
        io.emit("nuevoMensaje", {
          from,
          text,
          chat_id: chat.id,
          sender: "user",
          assigned_to: chat.assigned_to || null,
        });

        // Responder automáticamente
        await sendMessage(from, `Hola 👋, Bienvenido a DuoChat, estamos para tu asistencia.`);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Error en webhook:", error);
      res.sendStatus(500);
    }
  });

  // 📤 Función para enviar mensaje
  async function sendMessage(to, text) {
    try {
      await axios.post(
        API_URL,
        {
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: text },
        },
        {
          headers: {
            Authorization: `Bearer ${ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (error) {
      console.error("Error enviando mensaje:", error.response?.data || error);
    }
  }

  // 🔐 Verificación del webhook
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verificado ✅");
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  // 🧠 Socket.IO
  io.on("connection", (socket) => {
    console.log("Admin conectado ✅");

    socket.on("joinAdmin", (admin) => {
      socket.join(admin);
    });

    // Obtener chats según admin
    socket.on("getChats", async (admin) => {
      const { data: chats } = await supabase
        .from("chats")
        .select("*, messages(*)")
        .or(`assigned_to.is.null,assigned_to.eq.${admin}`)
        .order("last_timestamp", { ascending: false });

      socket.emit("chats", chats);
    });

    // Enviar mensaje admin
    socket.on("enviarAdmin", async ({ chat_id, text, admin }) => {
      const { data: chat } = await supabase.from("chats").select("*").eq("id", chat_id).single();
      if (!chat) return;

      // Guardar mensaje
      await supabase.from("messages").insert([
        { wa_id: chat.wa_id, direction: "outgoing", message: text, chat_id: chat.id }
      ]);

      // Asignar admin si no hay
      if (!chat.assigned_to) {
        await supabase.from("chats").update({ assigned_to: admin }).eq("id", chat.id);
      }

      // Actualizar último mensaje
      await supabase.from("chats").update({ last_message: text, last_timestamp: new Date() }).eq("id", chat.id);

      // Emitir al frontend
      io.emit("chatAsignado", { chat_id: chat.id, assigned_to: chat.assigned_to || admin, text, sender: "admin" });

      // Enviar mensaje real por WhatsApp
      await sendMessage(chat.wa_id, text);
    });
  });

  // 🚀 Iniciar servidor
  server.listen(5000, () => {
    console.log("Servidor escuchando en http://localhost:5000");
  });
}

main();
