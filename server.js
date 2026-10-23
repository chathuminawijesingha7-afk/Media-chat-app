require('dotenv').config();
const express=require('express'),http=require('http'),path=require('path'),crypto=require('crypto');
const jwt=require('jsonwebtoken'),bcrypt=require('bcryptjs'),cookieParser=require('cookie-parser'),helmet=require('helmet');
const admin=require('firebase-admin'),{Server}=require('socket.io');
const app=express(), server=http.createServer(app),io=new Server(server);
const secret=process.env.JWT_SECRET,production=process.env.NODE_ENV==='production';
if(!secret||secret.length<32)throw Error('Set a new JWT_SECRET of at least 32 characters');
if(!process.env.FIREBASE_PROJECT_ID||!process.env.FIREBASE_CLIENT_EMAIL||!process.env.FIREBASE_PRIVATE_KEY)throw Error('Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY');
admin.initializeApp({credential:admin.credential.cert({projectId:process.env.FIREBASE_PROJECT_ID,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')})});
const db=admin.firestore(),users=db.collection('users'),keys=db.collection('accountKeys'),chats=db.collection('chats'),online=new Map();
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}),express.json({limit:'20kb'}),cookieParser(),express.static(path.join(__dirname,'public')));
const clean=v=>String(v||'').trim().toLowerCase(),valid=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id);
const date=v=>v?.toDate?v.toDate().toISOString():v instanceof Date?v.toISOString():v||null;
const showUser=u=>({id:u.id,name:u.name,username:u.username,lastSeen:date(u.lastSeen)});
const showMsg=m=>({id:m.id,senderId:m.sender,recipientId:m.recipient,text:m.text,clientId:m.clientId||null,createdAt:date(m.createdAt),readAt:date(m.readAt)});
const pair=(a,b)=>[a,b].sort().join('_');
const key=(type,value)=>keys.doc(type+':'+crypto.createHash('sha256').update(value).digest('hex'));
async function user(id){if(!valid(id))return null;const doc=await users.doc(id).get();return doc.exists?{id:doc.id,...doc.data()}:null}
const token=id=>jwt.sign({sub:id},secret,{expiresIn:'7d'});
const cookie=(res,t)=>res.cookie('auth',t,{httpOnly:true,sameSite:'lax',secure:production,path:'/',maxAge:604800000});
const identity=req=>{try{return jwt.verify(req.cookies?.auth||'',secret).sub}catch{return null}};
async function auth(req,res,next){try{req.user=await user(identity(req));if(!req.user)return res.status(401).json({error:'Authentication required.'});next()}catch(e){next(e)}}
app.get('/api/health',async(req,res)=>{try{await users.limit(1).get();res.json({ok:true,database:'connected'})}catch{res.status(503).json({ok:false,database:'disconnected'})}});
app.post('/api/auth/register',async(req,res,next)=>{try{
 const name=String(req.body.name||'').trim(),username=clean(req.body.username),email=clean(req.body.email),password=String(req.body.password||'');
 if(name.length<2||name.length>60)return res.status(400).json({error:'Name must be 2–60 characters.'});
 if(!/^[a-z0-9_]{3,24}$/.test(username))return res.status(400).json({error:'Username must be 3–24 letters, numbers or underscores.'});
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:'Invalid email.'});
 if(password.length<8||password.length>128)return res.status(400).json({error:'Password must be 8–128 characters.'});
 const id=crypto.randomUUID(),u={id,name,username,email,passwordHash:await bcrypt.hash(password,12),createdAt:new Date(),lastSeen:new Date()};
 try{await db.runTransaction(async tx=>{const uk=key('username',username),ek=key('email',email);const a=await tx.get(uk),b=await tx.get(ek);if(a.exists||b.exists)throw Error('Account already exists');tx.create(uk,{id});tx.create(ek,{id});tx.create(users.doc(id),u)})}
 catch(e){if(e.message==='Account already exists'||e.code===6)return res.status(409).json({error:'Username or email is already in use.'});throw e}
 cookie(res,token(id));res.status(201).json({user:showUser(u)});
}catch(e){next(e)}});
app.post('/api/auth/login',async(req,res,next)=>{try{
 const identifier=clean(req.body.identifier),password=String(req.body.password||'');
 const k=await key(identifier.includes('@')?'email':'username',identifier).get();
 const u=k.exists?await user(k.data().id):null;
 if(!u||!await bcrypt.compare(password,u.passwordHash))return res.status(401).json({error:'Invalid login details.'});
 u.lastSeen=new Date();await users.doc(u.id).update({lastSeen:u.lastSeen});cookie(res,token(u.id));res.json({user:showUser(u)});
}catch(e){next(e)}});
app.post('/api/auth/logout',async(req,res,next)=>{try{const id=identity(req);if(await user(id))await users.doc(id).update({lastSeen:new Date()});res.clearCookie('auth',{httpOnly:true,sameSite:'lax',secure:production,path:'/'});res.json({ok:true})}catch(e){next(e)}});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:showUser(req.user)}));
app.get('/api/users',auth,async(req,res,next)=>{try{
 const search=clean(req.query.search),snap=await users.limit(1000).get();
 const result=snap.docs.map(d=>({id:d.id,...d.data()})).filter(u=>u.id!==req.user.id&&(!search||u.name.toLowerCase().includes(search)||u.username.includes(search))).sort((a,b)=>a.name.localeCompare(b.name)).slice(0,100).map(showUser);
 res.json({users:result});
}catch(e){next(e)}});
const feed=id=>users.doc(id).collection('feed');
app.get('/api/conversations',auth,async(req,res,next)=>{try{
 const snap=await feed(req.user.id).orderBy('createdAt','desc').limit(1000).get(),map=new Map();
 for(const d of snap.docs){const m=d.data(),partnerId=m.sender===req.user.id?m.recipient:m.sender;if(!map.has(partnerId))map.set(partnerId,{partnerId,lastMessage:{id:d.id,text:m.text,senderId:m.sender,createdAt:date(m.createdAt),readAt:date(m.readAt)}})}
 const conversations=(await Promise.all([...map.values()].map(async c=>{const u=await user(c.partnerId);return u?{...c,partner:showUser(u)}:null}))).filter(Boolean);res.json({conversations});
}catch(e){next(e)}});
app.get('/api/chats/:partnerId/messages',auth,async(req,res,next)=>{try{
 const pid=req.params.partnerId;if(!valid(pid)||!await user(pid))return res.status(400).json({error:'Invalid user id.'});
 let q=chats.doc(pair(pid,req.user.id)).collection('messages').orderBy('createdAt','desc');
 if(req.query.before){const before=new Date(req.query.before);if(!isNaN(before.getTime()))q=q.where('createdAt','<',before)}
 const limit=Math.min(Math.max(Number(req.query.limit)||80,1),120),snap=await q.limit(limit).get();
 res.json({messages:snap.docs.map(d=>showMsg({id:d.id,...d.data()})).reverse(),hasMore:snap.size===limit});
}catch(e){next(e)}});
async function markRead(id,pid){const recent=await feed(id).orderBy('createdAt','desc').limit(300).get(),unread={docs:recent.docs.filter(d=>d.data().sender===pid&&!d.data().readAt).slice(0,100),size:0},now=new Date();unread.size=unread.docs.length;
 for(let i=0;i<unread.docs.length;i+=100){const batch=db.batch();for(const d of unread.docs.slice(i,i+100)){for(const ref of [d.ref,feed(pid).doc(d.id),chats.doc(pair(id,pid)).collection('messages').doc(d.id)])batch.update(ref,{readAt:now})}await batch.commit()}
 return {updated:unread.size,readAt:now.toISOString()}}
app.post('/api/chats/:partnerId/read',auth,async(req,res,next)=>{try{const pid=req.params.partnerId;if(!valid(pid))return res.status(400).json({error:'Invalid user id.'});const r=await markRead(req.user.id,pid);io.to('user:'+pid).emit('message:read',{byUserId:req.user.id,partnerId:pid,readAt:r.readAt});res.json({updated:r.updated})}catch(e){next(e)}});
app.get(/^(?!\/api\/).*/,(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((e,req,res,next)=>{console.error(e);if(!res.headersSent)res.status(500).json({error:'Something went wrong on the server.'})});
io.use(async(socket,next)=>{try{
 const value=socket.handshake.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('auth='));
 const id=value?jwt.verify(decodeURIComponent(value.slice(5)),secret).sub:null;
 if(!await user(id))return next(Error('Unauthorized'));socket.userId=id;next();
}catch(e){next(Error('Unauthorized'))}});
io.on('connection',socket=>{
 const id=socket.userId;socket.join('user:'+id);online.set(id,(online.get(id)||0)+1);if(online.get(id)===1)io.emit('user:status',{userId:id,online:true});
 socket.emit('presence:state',{userIds:[...online.keys()]});users.doc(id).update({lastSeen:new Date()}).catch(()=>{});
 socket.on('presence:request',()=>socket.emit('presence:state',{userIds:[...online.keys()]}));
 socket.on('message:send',async(payload,callback)=>{try{
 const pid=String(payload?.recipientId||''),text=String(payload?.text||'').trim(),clientId=String(payload?.clientId||'').slice(0,80);
 if(!valid(pid)||pid===id||!await user(pid))throw Error('Invalid recipient.');
 if(!text||text.length>4000)throw Error('Message must be 1–4000 characters.');
 const mid=clientId?crypto.createHash('sha256').update(id+':'+clientId).digest('hex'):crypto.randomUUID();
 const msg={sender:id,recipient:pid,text,clientId:clientId||null,createdAt:new Date(),readAt:null};
 const ref=chats.doc(pair(id,pid)).collection('messages').doc(mid);
 let created=false;try{const batch=db.batch();batch.create(ref,msg);batch.create(feed(id).doc(mid),msg);batch.create(feed(pid).doc(mid),msg);await batch.commit();created=true}catch(e){if(e.code!==6&&e.code!=='already-exists')throw e}
 const saved=created?msg:(await ref.get()).data();if(!saved||saved.sender!==id||saved.clientId!==msg.clientId)throw Error('Unable to send message.');
 const result=showMsg({id:mid,...saved});if(created)io.to('user:'+id).to('user:'+pid).emit('message:new',result);callback?.({ok:true,message:result});
 }catch(e){callback?.({ok:false,error:e.message||'Unable to send message.'})}});
 for(const ev of ['typing:start','typing:stop'])socket.on(ev,p=>{const pid=String(p?.recipientId||'');if(valid(pid))io.to('user:'+pid).emit(ev,{fromUserId:id})});
 socket.on('message:markRead',async p=>{const pid=String(p?.partnerId||'');if(!valid(pid))return;try{const r=await markRead(id,pid);io.to('user:'+pid).emit('message:read',{byUserId:id,partnerId:pid,readAt:r.readAt})}catch(e){console.error(e)}});
 socket.on('disconnect',()=>{const n=(online.get(id)||1)-1;if(n>0)online.set(id,n);else{online.delete(id);users.doc(id).update({lastSeen:new Date()}).catch(()=>{});io.emit('user:status',{userId:id,online:false})}});
});
db.collection('users').limit(1).get().then(()=>server.listen(Number(process.env.PORT)||3000,()=>console.log('Chat server listening'))).catch(e=>{console.error(e);process.exit(1)});
