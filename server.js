const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function generateCardId() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    hostName: room.hostName,
    phase: room.phase,
    currentQuestionIndex: room.currentQuestionIndex,
    createdAt: room.createdAt,
    students: room.students.map(s => ({ id: s.id, name: s.name, score: s.score })),
    questions: room.questions.map(q => ({
      text: q.text,
      answers: q.answers,
      correctIndex: q.correctIndex,
      scored: !!q.scored,
      finalAnswers: q.finalAnswers || {}
    })),
    currentReads: room.currentReads || {}
  };
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit("roomUpdate", publicRoom(room));
}

function resetGame(room) {
  room.phase = "lobby";
  room.currentQuestionIndex = -1;
  room.currentReads = {};
  room.students.forEach(s => (s.score = 0));
  room.questions.forEach(q => {
    q.scored = false;
    q.finalAnswers = {};
  });
}

app.get("/api/room/:code", (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const room = rooms[code];
  if (!room) return res.status(404).json({ ok: false, message: "Room not found" });
  res.json({ ok: true, room: publicRoom(room) });
});

app.get("/", (req, res) => res.redirect("/host.html"));

io.on("connection", (socket) => {
  socket.on("createRoom", ({ hostName, title }, cb) => {
    const code = generateRoomCode();
    rooms[code] = {
      code,
      title: title || "Klassen-Quiz",
      hostName: hostName || "Lehrer",
      phase: "lobby",
      currentQuestionIndex: -1,
      currentReads: {},
      students: [],
      questions: [],
      createdAt: Date.now()
    };
    socket.join(code);
    cb?.({ ok: true, room: publicRoom(rooms[code]) });
    broadcastRoom(code);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });
    socket.join(code);
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("addStudent", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    const student = {
      id: generateCardId(),
      name: String(name || "").trim() || `Schüler ${room.students.length + 1}`,
      score: 0
    };

    room.students.push(student);
    cb?.({ ok: true, student, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("removeStudent", ({ code, studentId }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    room.students = room.students.filter(s => s.id !== String(studentId));
    delete room.currentReads[String(studentId)];
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("addQuestion", ({ code, text, answers, correctIndex }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    const q = {
      text: String(text || "").trim(),
      answers: Array.isArray(answers) ? answers.map(a => String(a || "").trim()).slice(0, 4) : [],
      correctIndex: Number(correctIndex) || 0,
      scored: false,
      finalAnswers: {}
    };

    if (!q.text || q.answers.length !== 4 || q.answers.some(a => !a)) {
      return cb?.({ ok: false, message: "Invalid question" });
    }

    room.questions.push(q);
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("startQuiz", ({ code }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });
    if (room.questions.length === 0) return cb?.({ ok: false, message: "No questions yet" });

    resetGame(room);
    room.phase = "question";
    room.currentQuestionIndex = 0;
    room.currentReads = {};
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("lockQuestion", ({ code }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    const q = room.questions[room.currentQuestionIndex];
    if (!q) return cb?.({ ok: false, message: "No active question" });

    if (!q.scored) {
      q.finalAnswers = { ...room.currentReads };
      q.scored = true;

      for (const student of room.students) {
        const choice = room.currentReads[student.id];
        if (choice === q.correctIndex) student.score += 100;
      }
    }

    room.phase = "reveal";
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("nextQuestion", ({ code }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    if (room.currentQuestionIndex < room.questions.length - 1) {
      room.currentQuestionIndex += 1;
      room.phase = "question";
      room.currentReads = {};
    } else {
      room.phase = "finished";
    }

    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("resetGame", ({ code }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });

    resetGame(room);
    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("scanBatch", ({ code, scans }, cb) => {
    code = String(code || "").toUpperCase();
    const room = rooms[code];
    if (!room) return cb?.({ ok: false, message: "Room not found" });
    if (room.phase !== "question") return cb?.({ ok: false, message: "Quiz not in question phase" });

    const q = room.questions[room.currentQuestionIndex];
    if (!q) return cb?.({ ok: false, message: "No active question" });

    for (const scan of scans || []) {
      const studentId = String(scan.studentId || "");
      const choice = Number(scan.choice);
      const student = room.students.find(s => s.id === studentId);
      if (!student) continue;
      if (![0, 1, 2, 3].includes(choice)) continue;
      room.currentReads[studentId] = choice;
    }

    cb?.({ ok: true, room: publicRoom(room) });
    broadcastRoom(code);
  });

  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
