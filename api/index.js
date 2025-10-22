import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { createClient } from "@supabase/supabase-js";

// 📱 Variables de Meta (usa tu token permanente)
const ACCESS_TOKEN = process.env.META_TOKEN; // 🔹 Token permanente
const PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const API_URL = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;

// 🧩 Supabase
const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.VITE_SUPABASE_SERVICE_ROLE
);

async function main() {
  if (!ACCESS_TOKEN) {
    console.error("❌ No se encontró META_TOKEN en .env");
    return;
  }

  const app = express();
  app.use(bodyParser.json());

  // Servidor HTTP + Socket.IO
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

  // 📩 Webhook para recibir mensajes desde WhatsApp
  app.post("/webhook", async (req, res) => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0]?.value;

      if (changes?.messages) {
        const message = changes.messages[0];
        const from = message.from;
        const text = message.text?.body || "";

        // Buscar o crear chat
        let { data: chat } = await supabase
          .from("chats")
          .select("*")
          .eq("wa_id", from)
          .single();

        if (!chat) {
          const { data: newChat } = await supabase
            .from("chats")
            .insert([{ wa_id: from }])
            .select()
            .single();
          chat = newChat;
        }

        // Insertar mensaje entrante
        await supabase.from("messages").insert([
          {
            wa_id: from,
            direction: "incoming",
            message: text,
            chat_id: chat.id,
          },
        ]);

        // Actualizar último mensaje
        await supabase
          .from("chats")
          .update({
            last_message: text,
            last_timestamp: new Date(),
          })
          .eq("id", chat.id);

        if (!chat.assigned_to) {
          io.emit("nuevoChat", { chat_id: chat.id, from, text });
        } else {
          // 👇 Si ya está asignado, mandar solo al admin asignado
          io.to(chat.assigned_to).emit("nuevoMensaje", {
            chat_id: chat.id,
            from,
            text,
            sender: "user",
          });
        }

        // 🔹 Verificar si es la primera vez que el usuario habla
        const { count, error: countError } = await supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("chat_id", chat.id);

        if (count === 1) {
          // Solo si es el primer mensaje
          await sendMessage(from, `Hola 👋, Bienvenido a DuoChat`);
          console.log("👋 Enviado mensaje de bienvenida al nuevo usuario:", from);
        } else {
          console.log("✅ Usuario recurrente, no se envía saludo:", from);
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Error webhook:", error);
      res.sendStatus(500);
    }
  });

  // 📤 Enviar mensaje a WhatsApp
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

  // 🧠 Conexión del admin (Socket.IO)
  io.on("connection", (socket) => {
    console.log("Admin conectado ✅");

    socket.on("joinAdmin", (adminEmail) => {
      socket.join(adminEmail);
      console.log(`Admin conectado: ${adminEmail}`);
    });

    // Obtener chats según admin
    socket.on("getChats", async (adminEmail) => {

      const normalizedEmail = adminEmail.toLowerCase().trim();

      const { data: chats, error } = await supabase
        .from("chats")
        .select("*, messages(*)")
        .or(`assigned_to.is.null,assigned_to.eq.${normalizedEmail}`)
        .order("last_timestamp", { ascending: false });

      if (error) console.error("Error cargando chats:", error);
      socket.emit("chats", chats || []);
    });

    // Enviar mensaje desde el admin
    // 🔐 Enviar mensaje desde el admin
    socket.on("enviarAdmin", async ({ chat_id, text, adminEmail }) => {
      console.log("Admin que envia mensaje:", adminEmail);
      const { data: chat, error } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chat_id)
        .single();

      if (error || !chat) return console.error("Chat no encontrado:", error);

      // Guardar mensaje saliente
      await supabase.from("messages").insert([
        { wa_id: chat.wa_id, direction: "outgoing", message: text, chat_id: chat.id },
      ]);

      let assignedTo = chat.assigned_to;

      // Si no tiene admin asignado → asignarlo
      if (!assignedTo) {
        assignedTo = adminEmail;
        console.log("Asignando chat al admin:", assignedTo)
        await supabase.from("chats").update({ assigned_to: assignedTo }).eq("id", chat.id);

        // Emitir a todos los admins que este chat fue asignado
        io.emit("chatAsignado", { chat_id: chat.id, assigned_to: assignedTo, text });
      }

      // Actualizar último mensaje
      await supabase
        .from("chats")
        .update({ last_message: text, last_timestamp: new Date() })
        .eq("id", chat.id);

      // Enviar mensaje real a WhatsApp
      await sendMessage(chat.wa_id, text);
    });

  });

  // 🚀 Iniciar servidor
  server.listen(5000, () => {
    console.log("Servidor escuchando en http://localhost:5000");
  });
}

main();
