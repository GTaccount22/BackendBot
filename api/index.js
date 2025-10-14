import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch"; // o global fetch si usas Node 18+
import { createClient } from "@supabase/supabase-js"; // 🆕 agregado

// 📱 Variables de Meta
const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;
const tempToken = process.env.META_TEMP_TOKEN;
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

// 🆕 Supabase (usa variables del backend, no de import.meta)
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

  // Crear servidor HTTP + Socket.IO
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

        // 🆕 Guardar mensaje recibido en Supabase
        await supabase.from("messages").insert([
          {
            wa_id: from,
            direction: "incoming",
            message: text,
          },
        ]);
        console.log("💾 Mensaje recibido guardado en Supabase");

        // Emitir el mensaje al frontend admin
        io.emit("nuevoMensaje", { from, text, sender: "user" });

        // Responder automáticamente
        await sendMessage(
          from,
          `Hola 👋, Bienvenido a DuoChat, estamos para tu asistencia.`
        );
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

  // 🧠 Manejo de conexión del admin (frontend)
  io.on("connection", (socket) => {
    console.log("Admin conectado ✅");

    socket.on("joinAdmin", (admin) => {
      socket.join(admin);
    });

    // Obtener chats según admin
    socket.on("getChats", async (admin) => {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .or(`assigned_to.is.null,assigned_to.eq.${admin}`)
        .order("timestamp", { ascending: true });

      // Agrupar por usuario
      const chats = data.reduce((acc, msg) => {
        if (!acc[msg.wa_id]) acc[msg.wa_id] = { wa_id: msg.wa_id, mensajes: [] };
        acc[msg.wa_id].mensajes.push(msg);
        return acc;
      }, {});

      socket.emit("chats", Object.values(chats));
    });

    socket.on("enviarAdmin", async ({ to, text, admin }) => {
      console.log("Admin responde a", to, ":", text);

      // Enviar mensaje real por WhatsApp
      await sendMessage(to, text);

      // 🆕 Guardar mensaje enviado en Supabase
      await supabase.from("messages").insert([
        {
          wa_id: to,
          direction: "outgoing",
          message: text,
          assigned_to: admin
        },
      ]);
      console.log("💾 Mensaje enviado guardado en Supabase");

      await supabase
        .from("messages")
        .update({ assigned_to: admin })
        .eq("wa_id", to)
        .is("assigned_to", null);

      // Emitir al frontend
      io.emit("chatAsignado", { from: to, text, sender: "admin", assigned_to: admin });
    });
  });

  // 🚀 Iniciar servidor
  server.listen(5000, () => {
    console.log("Servidor escuchando en http://localhost:5000");
  });
}

main();
