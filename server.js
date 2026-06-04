const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Base de datos SQLite en Railway
const db = new Database(path.join(__dirname, 'portal.db'));

// Crear tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS solicitudes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    apellido TEXT NOT NULL,
    cedula TEXT,
    fecha_nacimiento TEXT,
    sexo TEXT,
    telefono TEXT NOT NULL,
    email TEXT,
    ars TEXT,
    motivo TEXT,
    tipo_consulta TEXT DEFAULT 'Primera consulta',
    fecha_solicitada TEXT NOT NULL,
    hora_solicitada TEXT NOT NULL,
    status TEXT DEFAULT 'pendiente',
    codigo TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS horas_bloqueadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    UNIQUE(fecha, hora)
  );

  CREATE TABLE IF NOT EXISTS config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );
`);

// Seed config
const cfgExist = db.prepare("SELECT clave FROM config WHERE clave='medico_nombre'").get();
if (!cfgExist) {
  db.prepare("INSERT INTO config (clave, valor) VALUES (?,?)").run('medico_nombre', 'Dra. Nancy Esther Romero Castro');
  db.prepare("INSERT INTO config (clave, valor) VALUES (?,?)").run('medico_especialidad', 'Médico General');
  db.prepare("INSERT INTO config (clave, valor) VALUES (?,?)").run('gmail_usuario', process.env.GMAIL_USUARIO || '');
  db.prepare("INSERT INTO config (clave, valor) VALUES (?,?)").run('gmail_password', process.env.GMAIL_PASSWORD || '');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== API =====

// Obtener horas ocupadas para una fecha
app.get('/api/disponibilidad/:fecha', (req, res) => {
  const { fecha } = req.params;
  const ocupadas = db.prepare(
    "SELECT hora FROM solicitudes WHERE fecha_solicitada=? AND status != 'cancelada'"
  ).all(fecha).map(r => r.hora);
  const bloqueadas = db.prepare(
    "SELECT hora FROM horas_bloqueadas WHERE fecha=?"
  ).all(fecha).map(r => r.hora);
  res.json({ ocupadas: [...new Set([...ocupadas, ...bloqueadas])] });
});

// Crear solicitud de cita
app.post('/api/solicitud', (req, res) => {
  const { nombre, apellido, cedula, fecha_nacimiento, sexo,
          telefono, email, ars, motivo, tipo_consulta,
          fecha_solicitada, hora_solicitada } = req.body;

  if (!nombre || !apellido || !telefono || !fecha_solicitada || !hora_solicitada) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios.' });
  }

  // Verificar disponibilidad
  const existe = db.prepare(
    "SELECT id FROM solicitudes WHERE fecha_solicitada=? AND hora_solicitada=? AND status != 'cancelada'"
  ).get(fecha_solicitada, hora_solicitada);

  if (existe) {
    return res.status(409).json({ ok: false, error: 'Esa hora ya está ocupada. Elige otra.' });
  }

  const codigo = 'RC-' + Math.random().toString(36).toUpperCase().slice(2, 8);

  db.prepare(`INSERT INTO solicitudes
    (nombre, apellido, cedula, fecha_nacimiento, sexo, telefono, email,
     ars, motivo, tipo_consulta, fecha_solicitada, hora_solicitada, codigo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(nombre, apellido, cedula||null, fecha_nacimiento||null, sexo||null,
        telefono, email||null, ars||null, motivo||null,
        tipo_consulta||'Primera consulta', fecha_solicitada, hora_solicitada, codigo);

  // Enviar correo de confirmación si tiene email
  if (email) {
    enviarConfirmacion({ nombre, apellido, email, fecha_solicitada, hora_solicitada, tipo_consulta, codigo });
  }

  res.json({ ok: true, codigo });
});

// Obtener todas las solicitudes pendientes (para la app de escritorio)
app.get('/api/solicitudes', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY && apiKey !== 'miconsulta-dra-romero-2024') {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  const solicitudes = db.prepare(
    "SELECT * FROM solicitudes ORDER BY fecha_solicitada, hora_solicitada"
  ).all();
  res.json({ ok: true, solicitudes });
});

// Actualizar status de solicitud (confirmar/rechazar desde la app)
app.patch('/api/solicitud/:id', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY && apiKey !== 'miconsulta-dra-romero-2024') {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  const { status } = req.body;
  db.prepare("UPDATE solicitudes SET status=? WHERE id=?").run(status, req.params.id);
  res.json({ ok: true });
});

// Bloquear horas desde la app
app.post('/api/bloquear', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY && apiKey !== 'miconsulta-dra-romero-2024') {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  const { fecha, hora } = req.body;
  try {
    db.prepare("INSERT OR IGNORE INTO horas_bloqueadas (fecha, hora) VALUES (?,?)").run(fecha, hora);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ===== CORREO =====
async function enviarConfirmacion({ nombre, apellido, email, fecha_solicitada, hora_solicitada, tipo_consulta, codigo }) {
  try {
    const gmailUser = db.prepare("SELECT valor FROM config WHERE clave='gmail_usuario'").get()?.valor || process.env.GMAIL_USUARIO;
    const gmailPass = db.prepare("SELECT valor FROM config WHERE clave='gmail_password'").get()?.valor || process.env.GMAIL_PASSWORD;
    if (!gmailUser || !gmailPass) return;

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass }
    });

    const fechaFmt = new Date(fecha_solicitada + 'T12:00:00').toLocaleDateString('es-DO', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });

    await transporter.sendMail({
      from: `"Dra. Nancy Romero" <${gmailUser}>`,
      to: email,
      subject: `Solicitud de cita recibida — ${fechaFmt}`,
      html: `
        <div style="font-family:sans-serif;max-width:500px;margin:0 auto;">
          <div style="background:#3A5A40;padding:20px;border-radius:8px 8px 0 0;">
            <h2 style="color:#FEFAE0;margin:0;">Solicitud de cita recibida</h2>
            <p style="color:#A3B18A;margin:4px 0 0;">Dra. Nancy Esther Romero Castro · Médico General</p>
          </div>
          <div style="background:#FEFAE0;padding:20px;border-radius:0 0 8px 8px;border:1px solid #EEE8D5;">
            <p>Estimado/a <strong>${nombre} ${apellido}</strong>,</p>
            <p>Hemos recibido su solicitud de cita. Estaremos confirmando a la brevedad.</p>
            <div style="background:#F6F1E9;border-radius:8px;padding:14px;margin:16px 0;">
              <p style="margin:4px 0;"><strong>Fecha solicitada:</strong> ${fechaFmt}</p>
              <p style="margin:4px 0;"><strong>Hora:</strong> ${hora_solicitada}</p>
              <p style="margin:4px 0;"><strong>Tipo:</strong> ${tipo_consulta}</p>
              <p style="margin:4px 0;"><strong>Código de referencia:</strong> ${codigo}</p>
            </div>
            <p style="font-size:13px;color:#475569;">Guarde este código para cualquier consulta.<br>
            Le confirmaremos su cita por este mismo correo o por teléfono.</p>
            <hr style="border:none;border-top:1px solid #EEE8D5;margin:16px 0;">
            <p style="font-size:12px;color:#94A3B8;">Dra. Nancy Esther Romero Castro — Médico General<br>
            Exequátur 118-25 · CMD 57053</p>
          </div>
        </div>`
    });
  } catch(e) {
    console.error('Error enviando correo:', e.message);
  }
}

// Servir index.html para cualquier ruta no-API
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Portal corriendo en puerto ${PORT}`);
});
