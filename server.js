require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");

/* ---------------- BASIC SETUP ---------------- */

const app = express();
app.use(cors());

const server = http.createServer(app);

// FIX 1: Increase buffer size to allow images (default is 1MB, increased to 100MB)
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e8 
});

/* ---------------- MONGODB ---------------- */

// Make sure your .env has MONGO_URI defined
mongoose
  .connect(process.env.MONGO_URI || 'mongodb://localhost:27017/securechat')
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("MongoDB Connection Error", err));

/* ---------------- MESSAGE SCHEMA ---------------- */

const messageSchema = new mongoose.Schema({
  roomId: String,
  payload: Object, 
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

const Message = mongoose.model("Message", messageSchema);

/* ---------------- SOCKET LOGIC ---------------- */

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on("join-room", async (roomId) => {
    socket.join(roomId);

    // Send encrypted previous messages
    const messages = await Message.find({ roomId })
      .sort({ createdAt: 1 });

    socket.emit("previous-messages", messages);
  });

  socket.on("send-message", async ({ roomId, payload, tempId }) => {
    try {
      // Create message in DB
      const msg = await Message.create({
        roomId,
        payload
      });

      // FIX 2: Convert to object and attach tempId so the sender knows it's done
      const msgObj = msg.toObject();
      msgObj.tempId = tempId;

      // Broadcast to ALL clients in the room (including sender)
      io.to(roomId).emit("receive-message", msgObj);
    } catch (e) {
      console.error("Error sending message:", e);
    }
  });

  // --- DELETE MESSAGE LOGIC ---
  socket.on("delete-messages", async ({ roomId, messageIds }) => {
    if (!messageIds || messageIds.length === 0) return;

    try {
      const objectIds = messageIds.map(id => new mongoose.Types.ObjectId(id));
      
      const result = await Message.deleteMany({
        _id: { $in: objectIds },
        roomId: roomId 
      });

      if (result.deletedCount > 0) {
        io.to(roomId).emit("messages-deleted", { messageIds });
      }

    } catch (error) {
      console.error("Error deleting messages:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log("User Disconnected", socket.id);
  });
});

/* ---------------- START SERVER ---------------- */

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Secure server running on port ${PORT}`);
});
