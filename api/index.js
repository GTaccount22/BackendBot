import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuid } from "uuid";

dotenv.config();

import { createClient } from "@supabase/supabase-js";

// 📱 Variables de Meta
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

  const server = createServer(app);
  const io = new Server(server, { cors: { origin: "*" } });

  app.use(cors({ origin: "http://localhost:5173", methods: ["GET", "POST"] }));

  // 📩 Webhook
  app.post("/webhook", async (req, res) => {
    try {
      const entry = req.body.entry?.[0];
      const changes = entry?.changes?.[0]?.value;

      if (!changes?.messages) return res.sendStatus(200);

      const message = changes.messages[0];
      const from = message.from;
      const text = message.text?.body?.trim() || "";

      // 🔹 Buscar chat
      let { data: chat } = await supabase.from("chats").select("*").eq("wa_id", from).single();
      if (!chat) {
        const { data: newChat } = await supabase.from("chats").insert([{ wa_id: from }]).select().single();
        chat = newChat;
      }

      // 🔹 Guardar mensaje entrante
      await supabase.from("messages").insert([{
        wa_id: from,
        direction: "incoming",
        message: text,
        chat_id: chat.id,
      }]);

      io.to("todosAdmins").emit("nuevoMensaje", {
        id: uuid(),
        chat_id: chat.id,
        from: "Cliente",
        text,
        sender: "user",
        assigned_to: chat.assigned_to || null,
        hora: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });

      // 🔹 Buscar cliente
      let { data: client } = await supabase.from("clients").select("*").eq("phone", from).single();

      // 🔹 Si no hay cliente → pedir nombre
      if (!client) {
        if (chat.context !== "awaiting_name") {
          await sendMessage(from, "👋 ¡Hola! Bienvenido a *Peluquería DuoStyle* 💈\nPor favor, dime tu *nombre* para continuar:", chat.id);
          await supabase.from("chats").update({ context: "awaiting_name" }).eq("id", chat.id);
          return res.sendStatus(200);
        }

        const name = text.trim();
        if (!name || name.length < 2) {
          await sendMessage(from, "⚠️ Por favor, escribe tu *nombre completo* para continuar.", chat.id);
          return res.sendStatus(200);
        }

        const { data: newClient, error: clientError } = await supabase.from("clients").insert([{ name, phone: from }]).select().single();
        if (clientError) {
          console.error("Error guardando cliente:", clientError);
          return res.sendStatus(500);
        }

        client = newClient;

        // Actualizar contexto y mostrar servicios
        await supabase.from("chats").update({ client_id: client.id, context: "showing_services" }).eq("id", chat.id);
        chat.context = "showing_services";

        await sendServicesMenu(from, chat.id);
        return res.sendStatus(200);
      }

      // 🔹 Refrescar chat actualizado
      let { data: updatedChat } = await supabase.from("chats").select("*").eq("id", chat.id).single();
      chat = updatedChat;
      const currentContext = chat.context || "showing_services";

      // 🔹 Mostrar servicios
      if (currentContext === "showing_services") {
        const { data: services, error: servicesError } = await supabase.from("services").select("*");
        if (servicesError || !services || services.length === 0) {
          await sendMessage(from, "💈 En este momento no hay servicios disponibles.", chat.id);
          return res.sendStatus(200);
        }

        const choice = parseInt(text.trim());
        if (isNaN(choice) || choice < 1 || choice > services.length) {
          await sendServicesMenu(from, chat.id);
          return res.sendStatus(200);
        }

        const selectedService = services[choice - 1];

        // Actualizar chat con servicio y contexto
        await supabase.from("chats").update({
          selected_service: selectedService.id,
          context: "awaiting_date",
        }).eq("id", chat.id);

        // 🔹 Refrescar chat
        const { data: refreshedChat } = await supabase.from("chats").select("*").eq("id", chat.id).single();
        chat = refreshedChat;

        await sendMessage(from,
          `🗓️ Has elegido *${selectedService.name}* por $${selectedService.price}.\n\n` +
          "Por favor, indica la fecha y hora para tu reserva en formato:\n*DD-MM-YYYY HH:MM* (por ejemplo: 25-10-2025 15:30)",
          chat.id
        );

        return res.sendStatus(200);
      }

      // 🔹 Esperando fecha
      if (currentContext === "awaiting_date") {
        const selectedServiceId = chat.selected_service;

        if (!selectedServiceId) {
          await sendMessage(from, "⚠️ Primero debes elegir un servicio.", chat.id);
          await supabase.from("chats").update({ context: "showing_services" }).eq("id", chat.id);
          return res.sendStatus(200);
        }

        const dateRegex = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/;
        const match = text.match(dateRegex);
        if (!match) {
          await sendMessage(from, "⚠️ Formato inválido. Usa *DD-MM-YYYY HH:MM*", chat.id);
          return res.sendStatus(200);
        }

        const [, day, month, year, hour, minute] = match;
        const parsedDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);

        if (isNaN(parsedDate.getTime())) {
          await sendMessage(from, "⚠️ La fecha ingresada no es válida.", chat.id);
          return res.sendStatus(200);
        }

        if (parsedDate < new Date()) {
          await sendMessage(from, "⚠️ No puedes reservar en una fecha pasada.", chat.id);
          return res.sendStatus(200);
        }

        const { data: existing } = await supabase.from("bookings")
          .select("*")
          .eq("date", parsedDate.toISOString())
          .eq("service_id", selectedServiceId)
          .eq("status", "pending");

        if (existing.length > 0) {
          await sendMessage(from, "⚠️ Lo siento, ese horario ya está reservado.", chat.id);
          return res.sendStatus(200);
        }

        // Insertar reserva
        await supabase.from("bookings").insert([{
          client_id: client.id,
          service_id: selectedServiceId,
          date: parsedDate.toISOString(),
          status: "pending",
        }]);

        await sendMessage(from, "✅ ¡Listo! Tu reserva fue creada con éxito.", chat.id);

        await supabase.from("chats").update({ context: null, selected_service: null }).eq("id", chat.id);
        return res.sendStatus(200);
      }

      res.sendStatus(200);

    } catch (error) {
      console.error("Error webhook:", error);
      res.sendStatus(500);
    }
  });

  // 📤 Enviar mensaje
  async function sendMessage(to, text, chatId = null) {
    try {
      await axios.post(API_URL, {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } });

      await supabase.from("messages").insert([{
        wa_id: to,
        direction: "outgoing",
        message: text,
        chat_id: chatId,
      }]);

      io.to("todosAdmins").emit("nuevoMensaje", {
        id: uuid(),
        chat_id: chatId,
        from: "Bot",
        text,
        sender: "admin",
        assigned_to: null,
        hora: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      });

    } catch (error) {
      console.error("Error enviando mensaje:", error.response?.data || error);
    }
  }

  // 🔐 Verificación del webhook
  app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    res.sendStatus(403);
  });

  // 🧠 Conexión del admin (Socket.IO)
  io.on("connection", (socket) => {
    console.log("Admin conectado ✅");

    socket.on("joinAdmin", (adminEmail) => {
      socket.join(adminEmail);
      socket.join("todosAdmins");
    });

    socket.on("getChats", async (adminEmail) => {
      const normalizedEmail = adminEmail.toLowerCase().trim();
      const { data: chats } = await supabase
        .from("chats")
        .select("*, messages(*)")
        .or(`assigned_to.is.null,assigned_to.eq.${normalizedEmail}`)
        .order("last_timestamp", { ascending: false });
      socket.emit("chats", chats || []);
    });

    socket.on("enviarAdmin", async ({ chat_id, text, adminEmail }) => {
      const { data: chat } = await supabase.from("chats").select("*").eq("id", chat_id).single();
      if (!chat) return;

      await supabase.from("messages").insert([{ wa_id: chat.wa_id, direction: "outgoing", message: text, chat_id: chat.id }]);
      let assignedTo = chat.assigned_to || adminEmail;

      await supabase.from("chats").update({ assigned_to: assignedTo, last_message: text, last_timestamp: new Date() }).eq("id", chat.id);
      io.emit("chatAsignado", { chat_id: chat.id, assigned_to: assignedTo, text });
      await sendMessage(chat.wa_id, text);
    });
  });

  async function sendServicesMenu(to, chatId) {
    const { data: services } = await supabase.from("services").select("*");
    if (!services || services.length === 0) return await sendMessage(to, "💈 En este momento no hay servicios disponibles.", chatId);

    let menu = "💇‍♀️ *Nuestros Servicios Disponibles:*\n\n";
    services.forEach((s, i) => {
      menu += `${i + 1}. *${s.name}* - $${s.price}\n`;
      if (s.description) menu += `   ${s.description}\n`;
    });
    menu += "\nPor favor, responde con el número del servicio que deseas reservar 👇";
    await sendMessage(to, menu, chatId);
  }

  server.listen(5000, () => console.log("Servidor escuchando en http://localhost:5000"));
}

main();
