import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const usersPath = resolve(rootDir, "tmp", "users.json");
const signupVerificationsPath = resolve(rootDir, "tmp", "signup-verifications.json");

const pingramApiKey = process.env.PINGRAM_API_KEY ?? "";
const pingramSenderName = process.env.PINGRAM_SENDER_NAME ?? "GestureForge";
const pingramSenderEmail = process.env.PINGRAM_SENDER_EMAIL ?? "hello@gestureforge.local";
const pingramSignupCodeType = process.env.PINGRAM_SIGNUP_CODE_TYPE ?? "welcome_email";
const pingramWelcomeType = process.env.PINGRAM_WELCOME_TYPE ?? "welcome_email";
const pingramRegion = process.env.PINGRAM_REGION ?? "us";

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

function hashPassword(password, salt) {
  return createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

async function readUsers() {
  try {
    const parsed = JSON.parse(await readFile(usersPath, "utf-8"));
    return Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await mkdir(resolve(rootDir, "tmp"), { recursive: true });
  await writeFile(usersPath, JSON.stringify({ users }, null, 2), "utf-8");
}

async function readSignupVerifications() {
  try {
    const parsed = JSON.parse(await readFile(signupVerificationsPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeSignupVerifications(verifications) {
  await mkdir(resolve(rootDir, "tmp"), { recursive: true });
  await writeFile(signupVerificationsPath, JSON.stringify(verifications, null, 2), "utf-8");
}

function verificationCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendPingramEmail({ type, email, subject, html }) {
  if (!pingramApiKey) {
    return { status: "skipped", reason: "PINGRAM_API_KEY is not configured." };
  }

  try {
    const { Pingram } = await import("pingram");
    const pingram = new Pingram({ apiKey: pingramApiKey, region: pingramRegion });

    await pingram.send({
      type,
      to: { email },
      email: {
        subject,
        html,
        senderName: pingramSenderName,
        senderEmail: pingramSenderEmail,
      },
    });

    return { status: "sent" };
  } catch (error) {
    const status = error.response?.status;
    const statusText = error.response?.statusText;
    const details = [status, statusText, error.message].filter(Boolean).join(" ");
    return {
      status: "failed",
      reason: details || "Pingram send failed.",
      pingram_type: type,
      pingram_region: pingramRegion,
    };
  }
}

async function createSignupVerification({ email, role, name }) {
  const code = verificationCode();
  const verifications = await readSignupVerifications();
  verifications[email] = {
    code_hash: hashPassword(code, email),
    role,
    name,
    expires_at: Date.now() + 10 * 60 * 1000,
    created_at: new Date().toISOString(),
  };
  await writeSignupVerifications(verifications);

  const emailResult = await sendPingramEmail({
    type: pingramSignupCodeType,
    email,
    subject: "Your GestureForge verification code",
    html: `<h1>GestureForge verification</h1><p>Your sign up code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>`,
  });

  console.log(`[auth] verification code for ${email}: ${code}`);
  return { emailResult, code };
}

async function sendWelcomeEmail(user) {
  return sendPingramEmail({
    type: pingramWelcomeType,
    email: user.email,
    subject: "Welcome to GestureForge",
    html: `<h1>Welcome to GestureForge!</h1><p>Your ${user.role} workspace is ready.</p>`,
  });
}

function publicUser(user) {
  return {
    user_id: user.user_id,
    email: user.email,
    name: user.name,
    role: user.role,
    created_at: user.created_at,
  };
}

export async function signupUser(body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? "");
  const role = body.role === "player" ? "player" : "entrepreneur";
  const name = String(body.name ?? "").trim();
  const submittedCode = String(body.verification_code ?? "").trim();

  if (!email || !email.includes("@")) {
    return { status: 400, payload: { error: "Please enter a valid email." } };
  }

  if (password.length < 4) {
    return { status: 400, payload: { error: "Password must be at least 4 characters." } };
  }

  const users = await readUsers();

  if (users.some((user) => user.email === email)) {
    return { status: 409, payload: { error: "This email is already registered." } };
  }

  if (!submittedCode) {
    const { emailResult, code } = await createSignupVerification({ email, role, name });
    return {
      status: 202,
      payload: {
        status: "verification_required",
        message: "Verification code sent.",
        email_status: emailResult.status,
        email_error: emailResult.reason,
        ...(emailResult.status !== "sent" ? { dev_verification_code: code } : {}),
      },
    };
  }

  const verifications = await readSignupVerifications();
  const verification = verifications[email];

  if (
    !verification
    || verification.expires_at < Date.now()
    || verification.code_hash !== hashPassword(submittedCode, email)
  ) {
    return { status: 400, payload: { error: "Invalid or expired verification code." } };
  }

  const salt = randomUUID();
  const user = {
    user_id: randomUUID(),
    email,
    name,
    role,
    password_salt: salt,
    password_hash: hashPassword(password, salt),
    created_at: new Date().toISOString(),
  };

  users.push(user);
  delete verifications[email];
  await writeUsers(users);
  await writeSignupVerifications(verifications);
  const welcomeEmail = await sendWelcomeEmail(user);

  return {
    status: 201,
    payload: {
      user: publicUser(user),
      welcome_email_status: welcomeEmail.status,
      welcome_email_error: welcomeEmail.reason,
    },
  };
}

export async function loginUser(body) {
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? "");
  const requestedRole = body.role === "entrepreneur" || body.role === "player" ? body.role : "";
  const users = await readUsers();
  const user = users.find((candidate) => candidate.email === email);

  if (!user || user.password_hash !== hashPassword(password, user.password_salt)) {
    return { status: 401, payload: { error: "Invalid email or password." } };
  }

  return {
    status: 200,
    payload: {
      user: publicUser({
        ...user,
        role: requestedRole || user.role,
      }),
    },
  };
}
