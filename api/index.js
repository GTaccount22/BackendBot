import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { v4 as uuid } from "uuid";
import chrono from "chrono-node";
import { isValid, isAfter } from "date-fns";


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
        const text = message.text?.body?.trim() || "";

        // Buscar chat existente
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

        // 🔹 Guardar mensaje entrante (cliente) en Supabase
        if (chat) {
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
            id: uuid(),
            chat_id: chat.id,
            from: "Cliente",
            text,
            sender: "user", // ⚠️ 'cliente' para que el frontend lo muestre a la izquierda
            assigned_to: chat.assigned_to || null,
            hora: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          });
        }

        // Buscar o crear cliente
        let { data: client } = await supabase
          .from("clients")
          .select("*")
          .eq("phone", from)
          .single();

        // 🔹 Si no hay cliente y chat no está en contexto "awaiting_name" → pedir nombre
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

          console.log("chat.context:", chat.context);
          console.log("text recibido:", text);
          console.log("from:", from);

          // Si ya estaba esperando nombre → validar y guardar
          const { data: refreshedChat } = await supabase
            .from("chats")
            .select("*")
            .eq("id", chat.id)
            .single();

          chat = refreshedChat;


          // Si ya estaba esperando nombre → validar y guardar
          const name = text.trim();
          if (!name || name.length < 2) {
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

          // Actualizar contexto y mostrar servicios
          await supabase
            .from("chats")
            .update({ client_id: client.id, context: "showing_services" })
            .eq("id", chat.id);

          await sendServicesMenu(from, chat.id);
          return res.sendStatus(200);
        }

        // Obtener nuevamente el chat actualizado
        let { data: updatedChat } = await supabase
          .from("chats")
          .select("*")
          .eq("id", chat.id)
          .single();

        const currentContext = updatedChat?.context || "showing_services";

        // Mostrar servicios
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

          // Actualizamos el chat con el servicio y contexto
          await supabase
            .from("chats")
            .update({
              selected_service: selectedService.id,
              context: "awaiting_date",
            })
            .eq("id", chat.id);

          // 🔹 Leer nuevamente el chat actualizado
          const { data: refreshedChat } = await supabase
            .from("chats")
            .select("*")
            .eq("id", chat.id)
            .single();

          chat = refreshedChat; // reemplazamos la variable vieja

          await sendMessage(
            from,
            `🗓️ Has elegido *${selectedService.name}* por $${selectedService.price}.\n\n` +
            "Por favor, indica la fecha y hora para tu reserva en formato:\n" +
            "*DD-MM-YYYY HH:MM* (por ejemplo: 25-10-2025 15:30)",
            chat.id
          );

          return res.sendStatus(200);
        }




        // 🗓️ Esperando fecha
        if (currentContext === "awaiting_date") {
          const selectedServiceId = chat.selected_service;

          if (!client) {
            await sendMessage(from, "⚠️ Primero necesito tu nombre.", chat.id);
            await supabase.from("chats").update({ context: "awaiting_name" }).eq("id", chat.id);
            return res.sendStatus(200);
          }

          if (!selectedServiceId) {
            await sendMessage(from, "⚠️ Primero debes elegir un servicio.", chat.id);
            await supabase.from("chats").update({ context: "showing_services" }).eq("id", chat.id);
            return res.sendStatus(200);
          }

          // --- 1️⃣ Parseo flexible con chrono-node (lenguaje natural) ---
          let parsedDate = chrono.parseDate(text, new Date(), { forwardDate: true });

          // Intento alternativo si no entiende la frase
          if (!parsedDate) {
            const dateRegex = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2})$/;
            const match = text.match(dateRegex);
            if (match) {
              const [, day, month, year, hour, minute] = match;
              parsedDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00`);
            }
          }

          // --- 2️⃣ Validar que sea una fecha válida ---
          if (!parsedDate || !isValid(parsedDate)) {
            await sendMessage(
              from,
              "⚠️ No pude entender la fecha. Puedes escribir algo como:\n" +
              "👉 'mañana a las 5 de la tarde'\n" +
              "👉 'sábado a las 11'\n" +
              "👉 '25-10-2025 15:30'",
              chat.id
            );
            return res.sendStatus(200);
          }

          // --- 3️⃣ Validar que sea una fecha futura ---
          const now = new Date();
          if (!isAfter(parsedDate, now)) {
            await sendMessage(from, "⚠️ La fecha debe ser futura. Intenta nuevamente.", chat.id);
            return res.sendStatus(200);
          }

          // --- 4️⃣ Validar horario laboral (10:00 a 18:00) ---
          const WORK_START = 10;
          const WORK_END = 18;
          const hour = parsedDate.getHours();

          if (hour < WORK_START || hour >= WORK_END) {
            await sendMessage(
              from,
              `⚠️ Nuestro horario es de ${WORK_START}:00 a ${WORK_END}:00.\n` +
              "Por favor elige una hora dentro de ese rango.",
              chat.id
            );
            return res.sendStatus(200);
          }

          // --- 5️⃣ Validar disponibilidad ---
          const { data: existing } = await supabase
            .from("bookings")
            .select("*")
            .eq("date", parsedDate.toISOString())
            .eq("service_id", selectedServiceId)
            .eq("status", "pending");

          if (existing && existing.length > 0) {
            await sendMessage(from, "⚠️ Ese horario ya está reservado. Prueba con otro.", chat.id);
            return res.sendStatus(200);
          }

          // --- 6️⃣ Crear la reserva ---
          const { error: bookingError } = await supabase.from("bookings").insert([
            {
              client_id: client.id,
              service_id: selectedServiceId,
              date: parsedDate.toISOString(),
              status: "pending",
            },
          ]);

          if (bookingError) {
            console.error("Error creando reserva:", bookingError);
            await sendMessage(from, "❌ Hubo un error al crear la reserva. Intenta más tarde.", chat.id);
            return res.sendStatus(500);
          }

          // --- 7️⃣ Confirmar ---
          const fechaBonita = parsedDate.toLocaleString("es-CL", {
            weekday: "long",
            day: "numeric",
            month: "long",
            hour: "2-digit",
            minute: "2-digit",
          });

          await sendMessage(
            from,
            `✅ ¡Reserva confirmada!\n📅 *${fechaBonita}*\nTe esperamos en *Peluquería DuoStyle*.`,
            chat.id
          );

          // --- 8️⃣ Limpiar contexto ---
          await supabase.from("chats").update({ context: null, selected_service: null }).eq("id", chat.id);

          return res.sendStatus(200);
        }



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
          }
        });

      // Aquí guardas el mensaje
      const { data, error } = await supabase
        .from("messages")
        .insert([
          {
            wa_id: to,
            direction: "outgoing",
            message: text,
            chat_id: chatId,
          },
        ])
        .select();

      // ⚠️ AQUÍ AGREGA O CAMBIA ESTO:
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
      const { data: chat, error } = await supabase
        .from("chats")
        .select("*")
        .eq("id", chat_id)
        .single();

      if (error || !chat) return console.error("Chat no encontrado:", error);

      await supabase.from("messages").insert([
        { wa_id: chat.wa_id, direction: "outgoing", message: text, chat_id: chat.id },
      ]);

      let assignedTo = chat.assigned_to;

      if (!assignedTo) {
        assignedTo = adminEmail;
        await supabase.from("chats").update({ assigned_to: assignedTo }).eq("id", chat.id);
        io.emit("chatAsignado", { chat_id: chat.id, assigned_to: assignedTo, text });
      }

      await supabase
        .from("chats")
        .update({ last_message: text, last_timestamp: new Date() })
        .eq("id", chat.id);

      await sendMessage(chat.wa_id, text);
    });
  });

  async function sendServicesMenu(to, chatId) {
    const { data: services } = await supabase.from("services").select("*");
    if (!services || services.length === 0) {
      await sendMessage(to, "💈 En este momento no hay servicios disponibles.", chatId);
      return;
    }

    let menu = "💇‍♀️ *Nuestros Servicios Disponibles:*\n\n";
    services.forEach((s, i) => {
      menu += `${i + 1}. *${s.name}* - $${s.price}\n`;
      if (s.description) menu += `   ${s.description}\n`;
    });
    menu += "\nPor favor, responde con el número del servicio que deseas reservar 👇";

    await sendMessage(to, menu, chatId);
  }

  // 🚀 Iniciar servidor
  server.listen(5000, () => {
    console.log("Servidor escuchando en http://localhost:5000");
  });
}

main();
