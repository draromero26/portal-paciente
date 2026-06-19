const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join('/tmp', 'portal-db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return { solicitudes: [], horas_bloqueadas: [], pacientes: [], next_id: 1 };
}

function saveDB(db) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch(e) {}
}

let DB = loadDB();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.API_KEY || 'miconsulta-dra-romero-2024';

function authCheck(req, res) {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) { res.status(401).json({ ok: false, error: 'No autorizado.' }); return false; }
  return true;
}

// ===== BUSCAR PACIENTE POR CÉDULA =====
app.get('/api/paciente/:cedula', (req, res) => {
  DB = loadDB();
  const cedula = req.params.cedula.replace(/[^0-9]/g, ''); // solo números
  const paciente = DB.pacientes.find(p => {
    const pc = (p.cedula || '').replace(/[^0-9]/g, '');
    return pc === cedula && cedula.length >= 6;
  });
  if (paciente) {
    res.json({ ok: true, existe: true, paciente });
  } else {
    res.json({ ok: true, existe: false });
  }
});

// ===== SINCRONIZAR PACIENTE DESDE LA APP =====
app.post('/api/paciente/sync', (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  const p = req.body;
  if (!p.cedula) return res.json({ ok: false, error: 'Cédula requerida.' });
  const cedula = p.cedula.replace(/[^0-9]/g, '');
  const idx = DB.pacientes.findIndex(x => (x.cedula||'').replace(/[^0-9]/g,'') === cedula);
  const paciente = {
    nombre: p.nombre || '',
    apellido: p.apellido || '',
    cedula: p.cedula,
    fecha_nacimiento: p.fecha_nacimiento || null,
    sexo: p.sexo || null,
    telefono: p.telefono || null,
    email: p.email || null,
    ars: p.ars || null,
  };
  if (idx >= 0) { DB.pacientes[idx] = paciente; }
  else { DB.pacientes.push(paciente); }
  saveDB(DB);
  res.json({ ok: true });
});

// ===== DISPONIBILIDAD =====
app.get('/api/disponibilidad/:fecha', (req, res) => {
  DB = loadDB();
  const { fecha } = req.params;

  // 1. Solicitudes pendientes/confirmadas del portal
  const ocupadasPortal = DB.solicitudes
    .filter(s => s.fecha_solicitada === fecha && s.status !== 'cancelada')
    .map(s => s.hora_solicitada);

  // 2. Citas sincronizadas desde la app (confirmadas/pendientes)
  const citasApp = (DB.citas || [])
    .filter(c => c.fecha === fecha && c.status !== 'cancelada')
    .map(c => c.hora);

  // 3. Bloqueos manuales (días completos u horas específicas)
  const bloqueadas = DB.horas_bloqueadas
    .filter(b => b.fecha === fecha)
    .map(b => b.hora);

  // 4. FIX 1: Bloqueo automático de horas pasadas
  // Si la fecha solicitada es HOY, bloquear todas las horas anteriores a la hora actual
  // Tolerancia: bloquear también la próxima hora si estamos a menos de 30min
  const todasLasHoras = [];
  try {
    // Generar todas las horas posibles del día (08:00-11:00 y 14:00-16:00)
    for (let h = 8; h <= 11; h++) {
      for (let m = 0; m < 60; m += 30) {
        if (h === 11 && m > 0) break;
        todasLasHoras.push(String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'));
      }
    }
    for (let h = 14; h <= 16; h++) {
      for (let m = 0; m < 60; m += 30) {
        if (h === 16 && m > 0) break;
        todasLasHoras.push(String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0'));
      }
    }
  } catch(e) {}

  const horasPasadas = [];
  try {
    // Obtener fecha/hora actual en zona América/Santo_Domingo
    const ahora = new Date();
    // Obtener componentes en zona Santo_Domingo (UTC-4)
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santo_Domingo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    });
    const partes = {};
    fmt.formatToParts(ahora).forEach(p => { if (p.type !== 'literal') partes[p.type] = p.value; });
    const fechaHoy = partes.year + '-' + partes.month + '-' + partes.day;
    const horaActual = parseInt(partes.hour) * 60 + parseInt(partes.minute); // minutos desde 00:00

    if (fecha === fechaHoy) {
      // Bloquear todas las horas <= hora actual + 30min de margen
      todasLasHoras.forEach(h => {
        const [hh, mm] = h.split(':').map(Number);
        const minutosSlot = hh * 60 + mm;
        if (minutosSlot <= horaActual + 30) {
          horasPasadas.push(h);
        }
      });
    } else if (fecha < fechaHoy) {
      // Fecha pasada completa: bloquear todo
      horasPasadas.push(...todasLasHoras);
    }
  } catch(e) { console.error('Error calculando horas pasadas:', e); }

  res.json({
    ocupadas: [...new Set([...ocupadasPortal, ...citasApp, ...bloqueadas, ...horasPasadas])]
  });
});

// ===== SINCRONIZAR CITAS DESDE LA APP =====
app.post('/api/citas/sync', (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  if (!DB.citas) DB.citas = [];

  const citas = req.body.citas || [];
  // Reemplazar todas las citas con las del request (la app es source of truth)
  DB.citas = citas.map(c => ({
    id: c.id,
    paciente_nombre: c.paciente,
    paciente_email: c.email || null,
    telefono: c.telefono,
    fecha: c.fecha,
    hora: c.hora,
    tipo: c.tipo,
    status: c.status,
    recordatorio_enviado: c.recordatorio_enviado || null
  }));
  saveDB(DB);
  res.json({ ok: true, recibidas: citas.length });
});

// ===== CRON: ENVIAR RECORDATORIOS DEL DÍA SIGUIENTE =====
app.post('/api/cron/recordatorios', async (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  if (!DB.citas) DB.citas = [];

  // Calcular fecha del día siguiente
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaManana = manana.toISOString().split('T')[0];

  // Filtrar citas: del día siguiente, confirmadas o pendientes, sin recordatorio aún
  const elegibles = DB.citas.filter(c =>
    c.fecha === fechaManana &&
    (c.status === 'confirmada' || c.status === 'pendiente') &&
    c.paciente_email &&
    !c.recordatorio_enviado
  );

  let enviados = 0, fallos = 0;
  for (const cita of elegibles) {
    try {
      await enviarRecordatorio(cita);
      cita.recordatorio_enviado = new Date().toISOString();
      enviados++;
    } catch(e) {
      console.error('Error recordatorio cita', cita.id, ':', e.message);
      fallos++;
    }
  }
  saveDB(DB);
  res.json({ ok: true, fecha: fechaManana, total: elegibles.length, enviados, fallos });
});

// Función auxiliar para enviar recordatorio
async function enviarRecordatorio(cita) {
  const gmailUser = process.env.GMAIL_USUARIO;
  const gmailPass = process.env.GMAIL_PASSWORD;
  if (!gmailUser || !gmailPass) throw new Error('Sin configuración Gmail');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass }
  });

  const fechaFmt = new Date(cita.fecha + 'T12:00:00').toLocaleDateString('es-DO', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });

  await transporter.sendMail({
    from: '"Dra. Nancy Romero" <' + gmailUser + '>',
    to: cita.paciente_email,
    subject: 'Recordatorio: tiene cita mañana - ' + fechaFmt,
    html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;">' +
      '<div style="background:#3A5A40;padding:20px;border-radius:8px 8px 0 0;">' +
      '<h2 style="color:#FEFAE0;margin:0;">🔔 Recordatorio de cita</h2>' +
      '<p style="color:rgba(254,250,224,.8);margin:4px 0 0;">Dra. Nancy Esther Romero Castro · Médico General</p></div>' +
      '<div style="background:#FEFAE0;padding:20px;border-radius:0 0 8px 8px;border:1px solid #EEE8D5;">' +
      '<p>Estimado/a <strong>' + (cita.paciente_nombre || 'paciente') + '</strong>,</p>' +
      '<p>Le recordamos que tiene una cita programada para <strong>mañana</strong>:</p>' +
      '<div style="background:#F6F1E9;border-radius:8px;padding:14px;margin:16px 0;">' +
      '<p style="margin:4px 0;"><strong>Fecha:</strong> ' + fechaFmt + '</p>' +
      '<p style="margin:4px 0;"><strong>Hora:</strong> ' + cita.hora + '</p>' +
      '<p style="margin:4px 0;"><strong>Tipo:</strong> ' + (cita.tipo || 'Consulta') + '</p>' +
      '</div>' +
      '<p style="font-size:13px;color:#475569;">Por favor llegue 10 minutos antes de su cita. Si no puede asistir, le agradeceremos cancelarla con anticipación.</p>' +
      '<hr style="border:none;border-top:1px solid #EEE8D5;margin:16px 0;">' +
      '<p style="font-size:12px;color:#94A3B8;">Dra. Nancy Esther Romero Castro — Médico General</p></div></div>'
  });
}

// ===== CREAR SOLICITUD =====
app.post('/api/solicitud', (req, res) => {
  DB = loadDB();
  const { nombre, apellido, cedula, fecha_nacimiento, sexo,
          telefono, email, ars, motivo, tipo_consulta,
          fecha_solicitada, hora_solicitada } = req.body;

  if (!nombre || !apellido || !telefono || !fecha_solicitada || !hora_solicitada) {
    return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios.' });
  }

  const existe = DB.solicitudes.find(
    s => s.fecha_solicitada === fecha_solicitada &&
         s.hora_solicitada === hora_solicitada &&
         s.status !== 'cancelada'
  );
  if (existe) return res.status(409).json({ ok: false, error: 'Esa hora ya está ocupada. Elige otra.' });

  const codigo = 'RC-' + Math.random().toString(36).toUpperCase().slice(2, 8);
  const solicitud = {
    id: DB.next_id++,
    nombre, apellido, cedula: cedula||null,
    fecha_nacimiento: fecha_nacimiento||null,
    sexo: sexo||null, telefono,
    email: email||null, ars: ars||null,
    motivo: motivo||null,
    tipo_consulta: tipo_consulta||'Primera consulta',
    fecha_solicitada, hora_solicitada,
    status: 'pendiente', codigo,
    created_at: new Date().toISOString()
  };
  DB.solicitudes.push(solicitud);

  // Actualizar o crear paciente en el cache
  if (cedula) {
    const ced = cedula.replace(/[^0-9]/g, '');
    const pidx = DB.pacientes.findIndex(x => (x.cedula||'').replace(/[^0-9]/g,'') === ced);
    const pt = { nombre, apellido, cedula, fecha_nacimiento: fecha_nacimiento||null,
                 sexo: sexo||null, telefono, email: email||null, ars: ars||null };
    if (pidx >= 0) DB.pacientes[pidx] = pt;
    else DB.pacientes.push(pt);
  }

  saveDB(DB);
  if (email) enviarConfirmacion(solicitud);
  res.json({ ok: true, codigo });
});

// ===== SOLICITUDES (para la app) =====
app.get('/api/solicitudes', (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  res.json({ ok: true, solicitudes: DB.solicitudes });
});

app.patch('/api/solicitud/:id', (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  const id = parseInt(req.params.id);
  const idx = DB.solicitudes.findIndex(s => s.id === id);
  if (idx < 0) return res.status(404).json({ ok: false, error: 'No encontrada.' });
  DB.solicitudes[idx].status = req.body.status;
  saveDB(DB);
  res.json({ ok: true });
});

// ===== BLOQUEAR HORA =====
app.post('/api/bloquear', (req, res) => {
  if (!authCheck(req, res)) return;
  DB = loadDB();
  const { fecha, hora } = req.body;
  const existe = DB.horas_bloqueadas.find(b => b.fecha === fecha && b.hora === hora);
  if (!existe) { DB.horas_bloqueadas.push({ fecha, hora }); saveDB(DB); }
  res.json({ ok: true });
});

// ===== CORREO =====
async function enviarConfirmacion(s) {
  try {
    const gmailUser = process.env.GMAIL_USUARIO;
    const gmailPass = process.env.GMAIL_PASSWORD;
    if (!gmailUser || !gmailPass) return;
    const transporter = nodemailer.createTransport({
      service: 'gmail', auth: { user: gmailUser, pass: gmailPass }
    });
    const fechaFmt = new Date(s.fecha_solicitada + 'T12:00:00').toLocaleDateString('es-DO', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
    await transporter.sendMail({
      from: '"Dra. Nancy Romero" <' + gmailUser + '>',
      to: s.email,
      subject: '⏳ Solicitud recibida (pendiente de aprobación) — ' + fechaFmt,
      html: '<div style="font-family:sans-serif;max-width:500px;margin:0 auto;">' +
        '<div style="background:#D97706;padding:20px;border-radius:8px 8px 0 0;">' +
        '<h2 style="color:#FEFAE0;margin:0;">⏳ Solicitud pendiente de aprobación</h2>' +
        '<p style="color:rgba(254,250,224,.85);margin:4px 0 0;">Dra. Nancy Esther Romero Castro · Médico General</p></div>' +
        '<div style="background:#FEFAE0;padding:20px;border-radius:0 0 8px 8px;border:1px solid #EEE8D5;">' +
        '<p>Estimado/a <strong>' + s.nombre + ' ' + s.apellido + '</strong>,</p>' +
        '<div style="background:#FEF3C7;border-left:4px solid #D97706;padding:12px;margin:16px 0;border-radius:4px;">' +
        '<p style="margin:0;color:#92400E;font-weight:600;">⚠ ESTO NO ES UNA CONFIRMACIÓN</p>' +
        '<p style="margin:6px 0 0;font-size:13px;color:#78350F;">Hemos recibido su solicitud, pero aún debe ser aprobada por la Dra. Romero. Le enviaremos otro correo cuando la cita esté <strong>confirmada o rechazada</strong>.</p></div>' +
        '<p>Estos son los datos de su solicitud:</p>' +
        '<div style="background:#F6F1E9;border-radius:8px;padding:14px;margin:16px 0;">' +
        '<p style="margin:4px 0;"><strong>Fecha solicitada:</strong> ' + fechaFmt + '</p>' +
        '<p style="margin:4px 0;"><strong>Hora solicitada:</strong> ' + s.hora_solicitada + '</p>' +
        '<p style="margin:4px 0;"><strong>Tipo:</strong> ' + s.tipo_consulta + '</p>' +
        '<p style="margin:4px 0;"><strong>Código de referencia:</strong> ' + s.codigo + '</p></div>' +
        '<p style="font-size:12px;color:#94A3B8;">Guarde este código para cualquier consulta. Espere el correo de confirmación o rechazo antes de presentarse.</p>' +
        '<hr style="border:none;border-top:1px solid #EEE8D5;margin:16px 0;">' +
        '<p style="font-size:12px;color:#94A3B8;">Dra. Nancy Esther Romero Castro — Médico General</p></div></div>'
    });
  } catch(e) { console.error('Error correo:', e.message); }
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log('Portal corriendo en puerto ' + PORT));
