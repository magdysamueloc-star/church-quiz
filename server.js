const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database(process.env.DB_PATH || 'quiz.db');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';

app.use(express.json());
app.use(session({secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), resave:false, saveUninitialized:false, cookie:{httpOnly:true,sameSite:'lax',maxAge:86400000}}));
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, pin TEXT UNIQUE, title TEXT, status TEXT DEFAULT 'lobby', current_question INTEGER DEFAULT -1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS players(id TEXT PRIMARY KEY, room_id TEXT, name TEXT, student_code TEXT, score INTEGER DEFAULT 0, finished INTEGER DEFAULT 0, joined_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(room_id, student_code));
CREATE TABLE IF NOT EXISTS answers(id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, player_id TEXT, question_idx INTEGER, answer_idx INTEGER, correct INTEGER, points INTEGER, answered_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(player_id, question_idx));
`);

const QUESTIONS = [
 {q:'المحبة حسب الدرس هي:',a:['شعور مؤقت','سلوك واختيار','كلام جميل فقط','مساعدة الأصدقاء فقط'],c:1},
 {q:'أكمل: إن لم تكن لي محبة فقد صرت...',a:['شخصًا ضعيفًا','بلا مواهب','نحاسًا يطن أو صنجًا يرن','غير قادر على الكلام'],c:2},
 {q:'شخص متفوق يرفض مساعدة زميل ضعيف. ما الذي ينقصه؟',a:['العلم','النجاح','الثقة','المحبة'],c:3},
 {q:'شخص تبرع ثم نشر صورة ليحصل على المديح. ما المشكلة؟',a:['قيمة التبرع قليلة','لم يخبر أصدقاءه','هدفه المظهر لا المحبة','تبرع في وقت خاطئ'],c:2},
 {q:'زميلك حصل على درجة أعلى منك. ما الصفة المطلوبة؟',a:['لا تتفاخر','لا تحتد','لا تحسد','تصدق كل شيء'],c:2},
 {q:'سامحك صديقك وأعطاك فرصة جديدة. أي صفة يطبق؟',a:['لا تنتفخ','ترجو كل شيء','لا تتفاخر','لا تطلب ما لنفسها'],c:1},
 {q:'كلام جارح أمام الآخرين بحجة قول الحق. أي صفة غابت؟',a:['لا تحسد','تصبر على كل شيء','لا تقبح','لا تسقط أبدًا'],c:2},
 {q:'أكمل: تحتمل كل شيء، وتصدق كل شيء، و...',a:['تنسى كل شيء','تعرف كل شيء','ترجو وتصبر على كل شيء','تعطي كل شيء'],c:2},
 {q:'أي شيء لا يسقط أبدًا؟',a:['العلم','النبوات','الألسنة','المحبة'],c:3},
 {q:'كتب شخص عنك كلامًا سيئًا. ما التصرف الأقرب للمحبة؟',a:['أرد بقسوة','أنشر عنه كلامًا سيئًا','أقاطعه نهائيًا','أسأله بهدوء وأحاول أن أسامحه'],c:3}
];

const adminOnly=(req,res,next)=>req.session.admin?next():res.status(401).json({error:'غير مصرح'});
const emitRoom=(roomId)=>{
 const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);
 if(!room) return;
 const players=db.prepare('SELECT name,score,finished FROM players WHERE room_id=? ORDER BY score DESC, joined_at ASC').all(roomId);
 io.to(roomId).emit('roomState',{room,players,question: room.current_question>=0&&room.current_question<QUESTIONS.length?{index:room.current_question,total:QUESTIONS.length,q:QUESTIONS[room.current_question].q,a:QUESTIONS[room.current_question].a}:null});
};

app.post('/api/admin/login',(req,res)=>{if(req.body.password===ADMIN_PASSWORD){req.session.admin=true;return res.json({ok:true});}res.status(401).json({error:'كلمة المرور غير صحيحة'});});
app.post('/api/rooms',adminOnly,(req,res)=>{const id=crypto.randomUUID();let pin;do{pin=String(Math.floor(100000+Math.random()*900000));}while(db.prepare('SELECT 1 FROM rooms WHERE pin=?').get(pin));db.prepare('INSERT INTO rooms(id,pin,title) VALUES(?,?,?)').run(id,pin,req.body.title||'اختبار الدرس الثالث: المحبة');res.json({id,pin});});
app.post('/api/rooms/:id/start',adminOnly,(req,res)=>{db.prepare("UPDATE rooms SET status='playing',current_question=0 WHERE id=?").run(req.params.id);emitRoom(req.params.id);res.json({ok:true});});
app.post('/api/rooms/:id/next',adminOnly,(req,res)=>{const r=db.prepare('SELECT current_question FROM rooms WHERE id=?').get(req.params.id);const next=r.current_question+1;if(next>=QUESTIONS.length)db.prepare("UPDATE rooms SET status='finished' WHERE id=?").run(req.params.id);else db.prepare('UPDATE rooms SET current_question=? WHERE id=?').run(next,req.params.id);emitRoom(req.params.id);res.json({ok:true});});
app.get('/api/rooms/:id/report',adminOnly,(req,res)=>{const rows=db.prepare(`SELECT p.name,p.student_code,p.score,p.finished,COUNT(a.id) answered,SUM(a.correct) correct FROM players p LEFT JOIN answers a ON a.player_id=p.id WHERE p.room_id=? GROUP BY p.id ORDER BY p.score DESC`).all(req.params.id);res.json(rows);});
app.post('/api/join',(req,res)=>{const {pin,name,studentCode}=req.body;const room=db.prepare('SELECT * FROM rooms WHERE pin=?').get(pin);if(!room)return res.status(404).json({error:'كود المسابقة غير صحيح'});if(room.status==='finished')return res.status(409).json({error:'المسابقة انتهت'});if(!name?.trim()||!studentCode?.trim())return res.status(400).json({error:'اكتب الاسم والكود الشخصي'});const id=crypto.randomUUID();try{db.prepare('INSERT INTO players(id,room_id,name,student_code) VALUES(?,?,?,?)').run(id,room.id,name.trim(),studentCode.trim().toUpperCase());res.json({playerId:id,roomId:room.id});emitRoom(room.id);}catch{return res.status(409).json({error:'هذا الكود دخل المسابقة قبل كده، لا يمكن إعادة المحاولة'});}});
app.post('/api/answer',(req,res)=>{const {playerId,questionIdx,answerIdx}=req.body;const p=db.prepare('SELECT * FROM players WHERE id=?').get(playerId);if(!p)return res.status(401).json({error:'لاعب غير مسجل'});const room=db.prepare('SELECT * FROM rooms WHERE id=?').get(p.room_id);if(room.status!=='playing'||room.current_question!==questionIdx)return res.status(409).json({error:'السؤال غير متاح'});const correct=QUESTIONS[questionIdx].c===answerIdx?1:0;const points=correct?1000:0;try{db.prepare('INSERT INTO answers(room_id,player_id,question_idx,answer_idx,correct,points) VALUES(?,?,?,?,?,?)').run(p.room_id,playerId,questionIdx,answerIdx,correct,points);db.prepare('UPDATE players SET score=score+?,finished=? WHERE id=?').run(points,questionIdx===QUESTIONS.length-1?1:0,playerId);emitRoom(p.room_id);res.json({correct,points});}catch{res.status(409).json({error:'تم تسجيل إجابتك بالفعل'});}});

io.on('connection',socket=>{socket.on('watchRoom',roomId=>{socket.join(roomId);emitRoom(roomId);});});
server.listen(PORT,()=>console.log(`Love Quiz running on http://localhost:${PORT}`));
