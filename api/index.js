import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

import { createClient } from "@supabase/supabase-js";

// 📱 Variables de Meta (usa tu token permanente)
const ACCESS_TOKEN = process.env.META_TOKEN;
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

      if (!changes?.messages) return res.sendStatus(200);

      const message = changes.messages[0];
      const from = message.from;
      const text = message.text?.body?.trim() || "";

      // Buscar o crear chat
      let { data: chat } = await supabase
        .from("chats")
        .select("*")
        .eq("wa_id", from)
        .single();

      if (!chat) {
        const { data: newChat } = await supabase
          .from("chats")
          .insert([{ wa_id: from, context: null }])
          .select()
          .single();
        chat = newChat;
      }

      // 🔹 Guardar mensaje entrante (cliente)
      await supabase.from("messages").insert([
        {
          wa_id: from,
          direction: "incoming",
          message: text,
          chat_id: chat.id,
        },
      ]);

      // 🔹 Emitir al frontend/admin
      io.to("todosAdmins").emit("nuevoMensaje", {
        id: uuidv4(),
        chat_id: chat.id,
        from: "Cliente",
        text,
        sender: "user",
        assigned_to: chat.assigned_to || null,
        hora: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });

      // Buscar cliente
      let { data: client } = await supabase
        .from("clients")
        .select("*")
        .eq("phone", from)
        .single();

      // 🧠 Si no existe el cliente, pedir el nombre una sola vez
      if (!client) {
        if (chat.context !== "awaiting_name") {
          await sendMessage(
            from,
            "👋 ¡Hola! Bienvenido a *Peluquería DuoStyle* 💈\nPor favor, dime tu *nombre* para continuar:",
            chat.id
          );
          await supabase.from("chats").update({ context: "awaiting_name" }).eq("id", chat.id);
          return res.sendStatus(200);
        }

        // Ya estaba esperando el nombre
        const name = text.trim();
        if (name.length < 2) {
          await sendMessage(from, "⚠️ Por favor, escribe tu *nombre completo* para continuar.", chat.id);
          return res.sendStatus(200);
        }

        const { data: newClient, error: clientError } = await supabase
          .from("clients")
          .insert([{ name, phone: from }])
          .select()
          .single();

        if (clientError) {
          console.error("Error guardando cliente:", clientError);
          return res.sendStatus(500);
        }

        client = newClient;

        // Actualizar chat y mostrar servicios
        await supabase
          .from("chats")
          .update({ client_id: client.id, context: "showing_services" })
          .eq("id", chat.id);

        await sendServicesMenu(from);
        return res.sendStatus(200);
      }

      // Obtener chat actualizado
      const { data: updatedChat } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chat.id)
        .single();

      const context = updatedChat?.context;

      // 📋 Mostrar servicios
      if (context === "showing_services") {
        const { data: services } = await supabase.from("services").select("*");
        const choice = parseInt(text);

        if (!isNaN(choice) && services[choice - 1]) {
          const service = services[choice - 1];

          await supabase
            .from("chats")
            .update({ context: "awaiting_date", selected_service: service.id })
            .eq("id", chat.id);

          await sendMessage(
            from,
            `🗓️ Excelente elección: *${service.name}*\nPor favor, indícame una fecha y hora (ejemplo: *25-10-2025 15:30*).`,
            chat.id
          );
          return res.sendStatus(200);
        } else {
          await sendServicesMenu(from);
          return res.sendStatus(200);
        }
      }

      // 📅 Esperando fecha
      if (context === "awaiting_date") {
        const selectedServiceId = chat.selected_service;
        if (!selectedServiceId) return;

        const parsedDate = new Date(text.replace(/(\d{2})-(\d{2})-(\d{4})/, "$2/$1/$3"));

        if (isNaN(parsedDate.getTime())) {
          await sendMessage(from, "⚠️ Formato inválido. Usa *DD-MM-YYYY HH:MM*.", chat.id);
          return res.sendStatus(200);
        }

        await supabase.from("bookings").insert([
          {
            client_id: client.id,
            service_id: selectedServiceId,
            date: parsedDate.toISOString(),
            status: "pending",
          },
        ]);

        await sendMessage(
          from,
          "✅ ¡Listo! Tu reserva fue creada con éxito. Nos vemos pronto 💇‍♂️",
          chat.id
        );

        await supabase
          .from("chats")
          .update({ context: null, selected_service: null })
          .eq("id", chat.id);

        return res.sendStatus(200);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Error webhook:", error);
      res.sendStatus(500);
    }
  });

  // 📤 Enviar mensaje a WhatsApp
  async function sendMessage(to, text, chatId = null) {
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

      if (chatId) {
        await supabase.from("messages").insert([
          {
            wa_id: to,
            direction: "outgoing",
            message: text,
            chat_id: chatId,
          },
        ]);

        io.to("todosAdmins").emit("nuevoMensaje", {
          id: uuidv4(),
          chat_id: chatId,
          from: "Bot",
          text,
          sender: "admin",
          assigned_to: null,
          hora: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      }
    } catch (error) {
      console.error("Error enviando mensaje:", error.response?.data || error);
    }
  }

  // 🧾 Mostrar menú de servicios
  async function sendServicesMenu(to) {
    const { data: services } = await supabase.from("services").select("*");
    if (!services || services.length === 0) {
      await sendMessage(to, "💈 En este momento no hay servicios disponibles.");
      return;
    }

    let menu = "💇‍♀️ *Nuestros Servicios Disponibles:*\n\n";
    services.forEach((s, i) => {
      menu += `${i + 1}. *${s.name}* - $${s.price}\n`;
      if (s.description) menu += `   ${s.description}\n`;
    });
    menu += "\nPor favor, responde con el número del servicio que deseas reservar 👇";

    await sendMessage(to, menu);
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

  // 🧠 Socket.IO (Admin)
  io.on("connection", (socket) => {
    console.log("Admin conectado ✅");

    socket.on("joinAdmin", (adminEmail) => {
      socket.join(adminEmail);
      socket.join("todosAdmins");
      console.log(`Admin conectado: ${adminEmail}`);
    });

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

    socket.on("enviarAdmin", async ({ chat_id, text, adminEmail }) => {
      console.log("Admin que envía:", adminEmail);

      const { data: chat, error } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chat_id)
        .single();

      if (error || !chat) return console.error("Chat no encontrado:", error);

      await supabase.from("messages").insert([
        { wa_id: chat.wa_id, direction: "outgoing", message: text, chat_id },
      ]);

      let assignedTo = chat.assigned_to;
      if (!assignedTo) {
        assignedTo = adminEmail;
        await supabase.from("chats").update({ assigned_to: assignedTo }).eq("id", chat_id);
        io.emit("chatAsignado", { chat_id, assigned_to: assignedTo, text });
      }

      await sendMessage(chat.wa_id, text);
    });
  });

  // 🚀 Iniciar servidor
  server.listen(5000, () => {
    console.log("Servidor escuchando en http://localhost:5000");
  });
}

main();
