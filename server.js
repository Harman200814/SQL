const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1,-1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
// Load before db.js needs DATABASE_URL when this file is executed directly.
// db.js is already required above, so Render/local environments should provide DATABASE_URL.
loadEnvFile();

const { pool, q, initDatabase } = require('./db');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Codecrasher';
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set and at least 32 characters long.');
  process.exit(1);
}
let adminPasswordHash = process.env.ADMIN_PASSWORD_HASH || null;
if (!adminPasswordHash && process.env.ADMIN_PASSWORD) adminPasswordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12);
if (!adminPasswordHash) console.warn('WARNING: Admin login is disabled until ADMIN_PASSWORD_HASH or ADMIN_PASSWORD is configured.');
const BCRYPT_ROUNDS = 12;
const loginAttempts = new Map();
function rateLimitLogin(key, maxAttempts=10, windowMs=15*60*1000) {
  const now=Date.now(); let entry=loginAttempts.get(key);
  if(!entry || now>entry.resetAt){entry={count:0,resetAt:now+windowMs};loginAttempts.set(key,entry);}
  entry.count += 1; return entry.count <= maxAttempts;
}

app.set('trust proxy', 1);
app.use(express.json({limit:'100kb'}));
app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*8, httpOnly:true, sameSite:'lax', secure: process.env.NODE_ENV === 'production' }
}));
app.use(express.static(path.join(__dirname,'public')));

function distanceKm(lat1,lng1,lat2,lng2){const toRad=d=>d*Math.PI/180,R=6371,dLat=toRad(lat2-lat1),dLng=toRad(lng2-lng1),a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
function freshnessStatus(available,quantity,lastUpdated){if(!available||quantity<=0)return'red';if(!lastUpdated)return'yellow';const ageHours=(Date.now()-new Date(lastUpdated).getTime())/36e5;return ageHours<=1?'green':'yellow';}
function publicHospital(h){return{id:h.id,name:h.name,address:h.address,lat:h.lat,lng:h.lng,phone:h.phone,email:h.email,status:h.status};}
function requireAuth(req,res,next){if(!req.session.hospitalId)return res.status(401).json({error:'Not logged in'});next();}
function requireAdmin(req,res,next){if(!req.session.isAdmin)return res.status(401).json({error:'Admin login required'});next();}

app.get('/api/health', async (req,res)=>{try{const r=await q('SELECT NOW() AS now');res.json({status:'ok',database:'connected',time:r.rows[0].now});}catch(err){console.error(err);res.status(503).json({status:'error',database:'unavailable'});}});
app.get('/api/antivenoms', async (req,res)=>{try{res.json((await q('SELECT * FROM antivenoms ORDER BY id')).rows);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.get('/api/stats', async (req,res)=>{try{const r=await q(`SELECT (SELECT COUNT(*) FROM hospitals WHERE status='approved')::int AS "approvedHospitals",(SELECT COUNT(*) FROM antivenoms)::int AS "antivenomTypes",(SELECT COUNT(*) FROM bite_reports)::int AS "reportsLogged"`);res.json(r.rows[0]);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});

app.post('/api/hospitals/search', async (req,res)=>{try{const{category,lat,lng}=req.body;if(typeof lat!=='number'||typeof lng!=='number')return res.status(400).json({error:'lat and lng are required numbers'});const rows=(await q(`SELECT h.*,i.quantity,i.available,i.last_updated FROM hospitals h LEFT JOIN antivenoms a ON a.category=$1 LEFT JOIN inventory i ON i.hospital_id=h.id AND i.antivenom_id=a.id WHERE h.status='approved'`,[category])).rows;const results=rows.map(h=>({id:h.id,name:h.name,address:h.address,phone:h.phone,lat:h.lat,lng:h.lng,verified:true,distanceKm:Number(distanceKm(lat,lng,h.lat,h.lng).toFixed(1)),quantity:h.quantity||0,available:!!h.available,lastUpdated:h.last_updated,status:freshnessStatus(h.available,h.quantity||0,h.last_updated)}));results.sort((a,b)=>a.distanceKm-b.distanceKm);res.json(results);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});

app.post('/api/bite-reports', async (req,res)=>{try{const{ai_species,ai_category,ai_confidence,lat,lng,notes,phone}=req.body;const r=await q(`INSERT INTO bite_reports(ai_species,ai_category,ai_confidence,user_lat,user_lng,notes,contact_phone) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[ai_species||null,ai_category||null,ai_confidence||null,typeof lat==='number'?lat:null,typeof lng==='number'?lng:null,notes||null,phone||null]);res.json({ok:true,id:r.rows[0].id});}catch(err){console.error(err);res.status(500).json({error:'Could not save report'});}});

app.post('/api/hospital/register',async(req,res)=>{try{const{name,address,lat,lng,phone,email,password}=req.body;if(!name||!email||!password||typeof lat!=='number'||typeof lng!=='number')return res.status(400).json({error:'Name, email, password, and location are required.'});const normalizedEmail=String(email).trim().toLowerCase();const existing=(await q('SELECT id FROM hospitals WHERE email=$1',[normalizedEmail])).rows[0];if(existing)return res.status(409).json({error:'An account with this email already exists.'});const password_hash=bcrypt.hashSync(password,BCRYPT_ROUNDS);const r=await q(`INSERT INTO hospitals(name,address,lat,lng,phone,email,password_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,[name,address||'',lat,lng,phone||'',normalizedEmail,password_hash]);const hospitalId=r.rows[0].id;await q(`INSERT INTO inventory(hospital_id,antivenom_id,quantity,available,last_updated) SELECT $1,id,0,FALSE,NOW() FROM antivenoms ON CONFLICT(hospital_id,antivenom_id) DO NOTHING`,[hospitalId]);req.session.hospitalId=hospitalId;const hospital=(await q('SELECT * FROM hospitals WHERE id=$1',[hospitalId])).rows[0];res.json(publicHospital(hospital));}catch(err){console.error(err);if(err.code==='23505')return res.status(409).json({error:'An account with this email already exists.'});res.status(500).json({error:'Could not register hospital'});}});

app.post('/api/hospital/login',async(req,res)=>{try{const ip=req.ip||req.socket.remoteAddress||'unknown';if(!rateLimitLogin('hospital:'+ip))return res.status(429).json({error:'Too many login attempts. Try again later.'});const{email,password}=req.body||{};const hospital=(await q('SELECT * FROM hospitals WHERE email=$1',[String(email||'').trim().toLowerCase()])).rows[0];if(!hospital||!bcrypt.compareSync(password||'',hospital.password_hash))return res.status(401).json({error:'Incorrect email or password.'});req.session.hospitalId=hospital.id;res.json(publicHospital(hospital));}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.post('/api/hospital/logout',(req,res)=>{delete req.session.hospitalId;res.json({ok:true});});
app.get('/api/hospital/me',async(req,res)=>{try{if(!req.session.hospitalId)return res.status(401).json({error:'Not logged in'});const hospital=(await q('SELECT * FROM hospitals WHERE id=$1',[req.session.hospitalId])).rows[0];if(!hospital)return res.status(401).json({error:'Not logged in'});res.json(publicHospital(hospital));}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});

app.get('/api/directory',async(req,res)=>{try{const hospitals=(await q(`SELECT id,name,address,phone,lat,lng FROM hospitals WHERE status='approved' ORDER BY name`)).rows;const doctors=(await q(`SELECT d.id,d.name,d.specialty,d.phone,h.name AS hospital_name,h.id AS hospital_id FROM doctors d JOIN hospitals h ON h.id=d.hospital_id WHERE h.status='approved' ORDER BY h.name`)).rows;res.json({hospitals,doctors});}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});

app.get('/api/hospital/inventory',requireAuth,async(req,res)=>{try{const rows=(await q(`SELECT a.category,a.name,i.quantity,i.available,i.last_updated FROM antivenoms a LEFT JOIN inventory i ON i.antivenom_id=a.id AND i.hospital_id=$1 ORDER BY a.id`,[req.session.hospitalId])).rows;res.json(rows);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.post('/api/hospital/inventory',requireAuth,async(req,res)=>{try{const{category,quantity,available}=req.body;const antivenom=(await q('SELECT id FROM antivenoms WHERE category=$1',[category])).rows[0];if(!antivenom)return res.status(400).json({error:'Unknown antivenom category.'});const qty=Math.max(0,Number(quantity)||0);await q(`INSERT INTO inventory(hospital_id,antivenom_id,quantity,available,last_updated) VALUES($1,$2,$3,$4,NOW()) ON CONFLICT(hospital_id,antivenom_id) DO UPDATE SET quantity=EXCLUDED.quantity,available=EXCLUDED.available,last_updated=EXCLUDED.last_updated`,[req.session.hospitalId,antivenom.id,qty,!!available]);res.json({ok:true});}catch(err){console.error(err);res.status(500).json({error:'Could not update inventory'});}});
app.get('/api/hospital/doctors',requireAuth,async(req,res)=>{try{res.json((await q('SELECT * FROM doctors WHERE hospital_id=$1 ORDER BY id DESC',[req.session.hospitalId])).rows);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.post('/api/hospital/doctors',requireAuth,async(req,res)=>{try{const{name,specialty,phone}=req.body;if(!name)return res.status(400).json({error:'Doctor name is required.'});const r=await q('INSERT INTO doctors(hospital_id,name,specialty,phone) VALUES($1,$2,$3,$4) RETURNING id',[req.session.hospitalId,name,specialty||'',phone||'']);res.json({ok:true,id:r.rows[0].id});}catch(err){console.error(err);res.status(500).json({error:'Could not add doctor'});}});
app.delete('/api/hospital/doctors/:id',requireAuth,async(req,res)=>{try{const doctor=(await q('SELECT * FROM doctors WHERE id=$1',[req.params.id])).rows[0];if(!doctor||String(doctor.hospital_id)!==String(req.session.hospitalId))return res.status(404).json({error:'Doctor not found.'});await q('DELETE FROM doctors WHERE id=$1',[req.params.id]);res.json({ok:true});}catch(err){console.error(err);res.status(500).json({error:'Could not delete doctor'});}});

app.post('/api/admin/login',async(req,res)=>{try{const ip=req.ip||req.socket.remoteAddress||'unknown';if(!rateLimitLogin('admin:'+ip))return res.status(429).json({error:'Too many login attempts. Try again later.'});const{username,password}=req.body||{};if(!adminPasswordHash)return res.status(503).json({error:'Admin login is not configured on this server.'});const userOk=typeof username==='string'&&username===ADMIN_USERNAME;const passOk=typeof password==='string'&&password.length>0&&bcrypt.compareSync(password,adminPasswordHash);if(!userOk||!passOk)return res.status(401).json({error:'Incorrect username or password.'});req.session.isAdmin=true;res.json({ok:true});}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.post('/api/admin/logout',(req,res)=>{req.session.isAdmin=false;res.json({ok:true});});
app.get('/api/admin/me',(req,res)=>res.json({isAdmin:!!req.session.isAdmin}));
app.get('/api/admin/hospitals',requireAdmin,async(req,res)=>{try{res.json((await q(`SELECT id,name,address,lat,lng,phone,email,status,created_at FROM hospitals ORDER BY created_at DESC`)).rows);}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});
app.post('/api/admin/hospitals/:id/status',requireAdmin,async(req,res)=>{try{const{status}=req.body;if(!['pending','approved','rejected'].includes(status))return res.status(400).json({error:'Status must be pending, approved, or rejected.'});const r=await q('UPDATE hospitals SET status=$1 WHERE id=$2',[status,req.params.id]);if(!r.rowCount)return res.status(404).json({error:'Hospital not found.'});res.json({ok:true});}catch(err){console.error(err);res.status(500).json({error:'Database error'});}});

async function start(){try{await initDatabase();await q('SELECT 1');app.listen(PORT,()=>{console.log(`AntiVenom Finder running on port ${PORT}`);console.log(`Database: PostgreSQL connected`);console.log(`Demo mode: ${process.env.DEMO_MODE==='true'?'enabled (development only)':'disabled'}`);});}catch(err){console.error('Database initialization failed:',err);process.exit(1);}}
start();
