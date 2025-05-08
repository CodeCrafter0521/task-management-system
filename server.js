const express = require("express");
const { Sequelize, DataTypes, Op } = require("sequelize");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");

// Initialize Express and Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));

// Add route for root URL
app.get("/", (req, res) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (token) {
    try {
      jwt.verify(token, process.env.JWT_SECRET || "my-secure-jwt-secret-123");
      res.redirect("/dashboard.html");
    } catch (err) {
      res.redirect("/register.html");
    }
  } else {
    res.redirect("/register.html");
  }
});

// Database Configuration
const sequelize = new Sequelize(process.env.DATABASE_URL || "postgres://postgres:your_postgres_password@localhost:5432/taskmanagement", {
  dialect: "postgres",
});

const User = sequelize.define("User", {
  username: { type: DataTypes.STRING, allowNull: false, unique: true },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  role: { type: DataTypes.STRING, defaultValue: "member" },
});

const Task = sequelize.define("Task", {
  title: { type: DataTypes.STRING, allowNull: false },
  description: { type: DataTypes.TEXT },
  dueDate: { type: DataTypes.DATE },
  priority: { type: DataTypes.STRING },
  status: { type: DataTypes.STRING, defaultValue: "To-Do" },
  createdBy: { type: DataTypes.INTEGER },
  assigneeEmail: { type: DataTypes.STRING },
});

const Comment = sequelize.define("Comment", {
  comment: { type: DataTypes.TEXT, allowNull: false },
  userId: { type: DataTypes.INTEGER },
});

const Notification = sequelize.define("Notification", {
  message: { type: DataTypes.STRING, allowNull: false },
  userId: { type: DataTypes.INTEGER },
});

Task.hasMany(Comment);
Comment.belongsTo(Task);
User.hasMany(Task, { foreignKey: "createdBy" });
Task.belongsTo(User, { foreignKey: "createdBy" });

// Sync database (without force: true to persist data)
sequelize.sync().then(() => console.log("Database synced"));

// Email Configuration
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "todoapp002@gmail.com";
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || "epyarxydpfwdeqqu";
const transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: ADMIN_EMAIL,
    pass: EMAIL_PASSWORD,
  },
});

const sendEmail = async (to, subject, body) => {
  try {
    await transporter.sendMail({
      from: ADMIN_EMAIL,
      to: to,
      subject: subject,
      text: body,
    });
    return { message: `Email sent to ${to}: ${subject}` };
  } catch (error) {
    console.error("Email sending error:", error);
    return { message: `Failed to send email to ${to}: ${subject}` };
  }
};

// Middleware to Authenticate Token
function authenticateToken(req, res, next) {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    console.log("No token provided in request");
    return res.status(401).json({ message: "Access denied: No token provided" });
  }
  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || "my-secure-jwt-secret-123");
    console.log("Token verified, payload:", verified);
    req.user = verified;
    next();
  } catch (error) {
    console.error("Token verification error:", error.message);
    res.status(400).json({ message: "Invalid token" });
  }
}

// Socket.IO Connection
io.on("connection", (socket) => {
  socket.on("disconnect", () => {});
});

// Authentication Routes
app.post("/api/auth/register", async (req, res) => {
  const { username, email, password } = req.body;
  const role = email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? "admin" : "member";
  console.log(`Registering user: ${email}, assigned role: ${role}`);
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    const user = await User.create({ username: username, email: email, password: hashedPassword, role: role });
    console.log(`User registered: ${user.email}, role: ${user.role}`);
    res.status(201).json(user);
  } catch (error) {
    console.error("Registration error:", error.message);
    res.status(400).json({ message: "Username or email already exists" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { username, email, password } = req.body;
  const user = await User.findOne({
    where: {
      [Op.or]: [
        { username: username || "" },
        { email: email || "" },
      ],
    },
  });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    console.log(`Login failed for ${username || email}: Invalid credentials`);
    return res.status(401).json({ message: "Invalid credentials" });
  }
  console.log(`User logged in: ${user.email}, role: ${user.role}`);
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET || "my-secure-jwt-secret-123", { expiresIn: "1h" });
  console.log(`Generated token for user ${user.id}: ${token}`);
  const emailNotification = await sendEmail(
    user.email,
    "Welcome Back to Task Management System",
    "You have successfully logged in."
  );
  io.to(user.id).emit("notification", emailNotification);
  res.json({ token: token, userId: user.id, role: user.role });
});

// Task Routes
app.post("/api/tasks", authenticateToken, async (req, res) => {
  const { title, description, dueDate, priority, status } = req.body;
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  try {
    const task = await Task.create({
      title: title,
      description: description,
      dueDate: dueDate,
      priority: priority,
      status: status,
      createdBy: user.id,
    });
    console.log(`Task created by user ${user.id}: ${task.title}`);
    res.status(201).json({ message: "Task created successfully", task: task });
  } catch (error) {
    console.error("Task creation error:", error.message);
    res.status(500).json({ message: "Failed to create task", error: error.message });
  }
});

app.get("/api/tasks", authenticateToken, async (req, res) => {
  const { status, priority, dueDate, search, missed } = req.query;
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  const now = new Date();

  let where = {
    [Op.or]: [
      { createdBy: req.user.id },
      { assigneeEmail: user.email },
    ],
  };

  if (status) where.status = status;
  if (priority) where.priority = priority;
  if (search) where.title = { [Op.iLike]: `%${search}%` };
  if (missed === "true") {
    where.status = "To-Do";
    where.dueDate = { [Op.lt]: now };
  }

  let order = [];
  if (dueDate) {
    order = [["dueDate", dueDate === "asc" ? "ASC" : "DESC"]];
  } else {
    order = [
      [
        Sequelize.literal(`CASE 
          WHEN priority = 'High' THEN 1 
          WHEN priority = 'Medium' THEN 2 
          WHEN priority = 'Low' THEN 3 
          END`),
        "ASC",
      ],
      ["dueDate", "ASC"],
    ];
  }

  try {
    const tasks = await Task.findAll({ where: where, order: order });
    console.log(`Fetched ${tasks.length} tasks for user ${req.user.id}`);
    res.json(tasks);
  } catch (error) {
    console.error("Fetch tasks error:", error.message);
    res.status(500).json({ message: "Failed to fetch tasks", error: error.message });
  }
});

app.put("/api/tasks/:id/complete", authenticateToken, async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });
  if (task.createdBy !== req.user.id && task.assigneeEmail !== (await User.findByPk(req.user.id)).email) {
    return res.status(403).json({ message: "Not authorized" });
  }
  task.status = "Done";
  await task.save();
  const notification = await Notification.create({
    message: `Task "${task.title}" marked as completed`,
    userId: task.createdBy,
  });
  io.to(task.createdBy).emit("notification", notification);
  res.json({ message: "Task completed successfully" });
});

app.put("/api/tasks/:id/assign", authenticateToken, async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });
  if (task.createdBy !== req.user.id) {
    return res.status(403).json({ message: "Only the task creator can assign this task" });
  }
  const { assigneeEmail } = req.body;
  const assignee = await User.findOne({ where: { email: assigneeEmail } });
  if (!assignee) return res.status(404).json({ message: "Assignee not found" });
  task.assigneeEmail = assigneeEmail;
  await task.save();
  const notification = await Notification.create({
    message: `Task "${task.title}" assigned to ${assigneeEmail}`,
    userId: assignee.id,
  });
  io.to(assignee.id).emit("notification", notification);
  const emailNotification = await sendEmail(
    assigneeEmail,
    "Task Assigned",
    `A new task "${task.title}" has been assigned to you. Due date: ${task.dueDate}`
  );
  io.to(assignee.id).emit("notification", emailNotification);
  res.json({ message: "Task assigned successfully" });
});

app.delete("/api/tasks/:id", authenticateToken, async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });
  if (task.createdBy !== req.user.id) {
    return res.status(403).json({ message: "Only the task creator can delete this task" });
  }
  await task.destroy();
  res.json({ message: "Task deleted successfully" });
});

// Comment Routes
app.get("/api/tasks/:id/comments", authenticateToken, async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });
  const user = await User.findByPk(req.user.id);
  if (task.createdBy !== req.user.id && task.assigneeEmail !== user.email) {
    return res.status(403).json({ message: "Not authorized to view comments" });
  }
  const comments = await Comment.findAll({ where: { taskId: req.params.id } });
  res.json(comments);
});

app.post("/api/tasks/:id/comments", authenticateToken, async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) return res.status(404).json({ message: "Task not found" });
  const user = await User.findByPk(req.user.id);
  if (task.createdBy !== req.user.id && task.assigneeEmail !== user.email) {
    return res.status(403).json({ message: "Not authorized to add comments" });
  }
  const { comment } = req.body;
  const newComment = await Comment.create({
    comment: comment,
    userId: req.user.id,
    taskId: req.params.id,
  });
  const notification = await Notification.create({
    message: `New comment on task "${task.title}": ${comment}`,
    userId: task.createdBy,
  });
  io.to(task.createdBy).emit("notification", notification);
  res.status(201).json(newComment);
});

// User Routes (Admin Only)
app.get("/api/users", authenticateToken, async (req, res) => {
  console.log(`User role in /api/users: ${req.user.role}`);
  if (!req.user.role || req.user.role !== "admin") {
    console.log("Admin access denied for user:", req.user);
    return res.status(403).json({ message: "Admin access required" });
  }
  try {
    const users = await User.findAll();
    console.log(`Fetched ${users.length} users for admin ${req.user.id}`);
    res.json(users);
  } catch (error) {
    console.error("Fetch users error:", error.message);
    res.status(500).json({ message: "Failed to fetch users", error: error.message });
  }
});

app.delete("/api/users/:id", authenticateToken, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ message: "Admin access required" });
  const user = await User.findByPk(req.params.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  if (user.role === "admin") return res.status(403).json({ message: "Cannot delete admin user" });
  await user.destroy();
  res.json({ message: "User deleted successfully" });
});

// Notification Routes
app.get("/api/notifications", authenticateToken, async (req, res) => {
  const notifications = await Notification.findAll({ where: { userId: req.user.id } });
  res.json(notifications);
});

// Start Server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));