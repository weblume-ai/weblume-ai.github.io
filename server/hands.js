"use strict";
// Weblume "hands": a browser it drives (dedicated Chrome profile, Playwright), Asser's Google account (his own OAuth client),
// and small computer tasks. Anything irreversible returns {confirm:{id,text}} instead of running; it runs only when the
// chat UI posts that id to /api/hands/confirm after Asser clicks "موافق". The model never sees or sends confirm ids.
const fs=require("fs"),path=require("path"),os=require("os"),crypto=require("crypto"),cp=require("child_process");
const ROOT=path.join(__dirname,"..");
const SECRET_RX=/(sk-|sk_|gsk_|nvapi-|r8_|ghp_|github_pat_|AIza|xox[abp]-|eyJ|ya29\.|1\/\/)[\w-]{8,}|[A-Za-z0-9]{32,}|password|passwd|باسورد|باسوورد|كلمة (السر|المرور)|رقم (الكارت|البطاقة|الفيزا)|\b(?:\d[ -]?){13,19}\b/i;
const ok=(step,result,extra)=>({code:200,body:Object.assign({step,result},extra||{})});
const bad=(code,error)=>({code,body:{error}});
const str=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";

// ---- confirmations: one-time, bound to the exact action, expire after 5 minutes
const pending=new Map();
function ask(text,run){const id=crypto.randomUUID();pending.set(id,{text,run,t:Date.now()});
  for(const[k,v]of pending)if(Date.now()-v.t>300000)pending.delete(k);
  return{code:200,body:{confirm:{id,text},step:"⏸ مستني موافقتك: "+text}}}
async function confirm(b){const p=pending.get(b&&b.id);pending.delete(b&&b.id);
  if(!p||Date.now()-p.t>300000)return bad(410,"الموافقة دي انتهت أو اتستخدمت. اطلب الخطوة تاني.");
  return p.run()}

// ---- browser (Playwright driving the installed Chrome with its own profile; Asser signs in there himself)
const PROFILE=()=>process.env.WEBLUME_CHROME_PROFILE||path.join(process.env.LOCALAPPDATA||os.homedir(),"Weblume","chrome-profile");
let ctx=null,page=null,launcher=null;
const setLauncher=f=>{launcher=f;ctx=null;page=null}; // tests inject a fake browser
async function getPage(){
  if(page&&!page.isClosed())return page;
  if(!ctx){let launch=launcher;
    if(!launch){let pw;try{pw=require("playwright-core")}catch(e){throw Object.assign(new Error("مكتبة المتصفح مش متسطبة. اقفل start.bat وشغّله تاني (بيسطبها لوحده)."),{code:503})}
      launch=dir=>pw.chromium.launchPersistentContext(dir,{channel:"chrome",headless:process.env.WEBLUME_HEADLESS==="1",viewport:null})}
    try{ctx=await launch(PROFILE())}catch(e){throw Object.assign(new Error("مش قادر أفتح كروم: "+String(e.message).split("\n")[0].slice(0,200)+" (لو نافذة كروم Weblume مفتوحة ومعلّقة اقفلها)"),{code:502})}
    ctx.on("close",()=>{ctx=null;page=null})}
  page=ctx.pages()[0]||await ctx.newPage();return page}
// Runs in the page: numbers the visible things you can click or type in, returns the page as text.
const MARK=()=>{document.querySelectorAll("[data-wl]").forEach(e=>e.removeAttribute("data-wl"));
  const vis=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"};
  const items=[];let n=0;
  for(const e of document.querySelectorAll('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=searchbox],[role=textbox],[contenteditable=true]')){
    if(n>=120)break;if(!vis(e))continue;e.setAttribute("data-wl",++n);
    const pw=(e.getAttribute("type")||"").toLowerCase()==="password";
    const label=(e.getAttribute("aria-label")||e.innerText||(pw?"":e.value)||e.placeholder||e.title||e.name||"").replace(/\s+/g," ").trim().slice(0,80);
    items.push({n,tag:e.tagName.toLowerCase()+(e.tagName==="INPUT"?":"+(e.type||"text"):""),label:pw?"(خانة باسورد)":label})}
  return{url:location.href,title:document.title,text:(document.body?document.body.innerText:"").replace(/\n{3,}/g,"\n\n").slice(0,6000),items}};
const DESCRIBE=n=>{const e=document.querySelector('[data-wl="'+n+'"]');if(!e)return null;const f=e.form||e.closest("form"),t=(e.getAttribute("type")||"").toLowerCase();
  return{tag:e.tagName.toLowerCase(),type:t,text:(e.innerText||(t==="password"?"":e.value)||"").replace(/\s+/g," ").trim().slice(0,120),
    attrs:[e.name,e.id,e.placeholder,e.getAttribute("aria-label"),e.title,e.getAttribute("autocomplete")].filter(Boolean).join(" ").slice(0,300),
    autocomplete:(e.getAttribute("autocomplete")||"").toLowerCase(),
    submit:(e.tagName==="BUTTON"&&(t||"submit")==="submit"&&!!f)||(e.tagName==="INPUT"&&/^(submit|image)$/.test(t)),
    search:t==="search"||!!e.closest("[role=search]")||!!(f&&/search/i.test(f.getAttribute("action")||""))||/^(q|query|search|s|search_query)$/i.test(e.name||""),
    host:location.hostname}};
const RISKY=/\b(send|submit|buy|purchase|order|checkout|pay|payment|delete|remove|post|publish|confirm|subscribe|sign ?up|register|book|reserve|transfer|donate|unsubscribe|apply)\b|إرسال|ارسال|ابعت|أرسل|ارسل|شراء|اشتر|ادفع|دفع|حذف|احذف|امسح|نشر|انشر|تأكيد|تاكيد|أكد|اطلب|إتمام|اتمام|اشترك|سجّل|سجل|احجز|حجز|تحويل/i;
const SEARCH_HOST=/(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|youtube\.com)$/;
const clickRisk=d=>RISKY.test(d.text+" "+d.attrs)||(d.submit&&!d.search&&!SEARCH_HOST.test(d.host));
const enterRisk=d=>!d.search&&!SEARCH_HOST.test(d.host);
const secretField=d=>d.type==="password"||/^cc-|password|one-time-code/.test(d.autocomplete)||/pass|card|cvv|cvc|iban|otp|\bpin\b|security.?code|كلمة|بطاقة|كارت|رمز/i.test(d.attrs);
const pageText=r=>"العنوان: "+r.title+"\nالرابط: "+r.url+"\n\nالنص:\n"+r.text+"\n\nحاجات تقدر تضغطها أو تكتب فيها (استخدم الرقم n):\n"+r.items.map(i=>"["+i.n+"] "+i.tag+" "+i.label).join("\n");
async function readPage(p){await p.waitForLoadState("domcontentloaded").catch(()=>{});return p.evaluate(MARK)}
const captcha=u=>/google\.[a-z.]+\/sorry\//.test(u);
const CAPTCHA_MSG="جوجل طالب يتأكد إنك مش روبوت. حلّها انت في نافذة كروم Weblume وبعدين قولي أكمّل (أنا ممنوع أحل الكابتشا).";
function normName(s){return String(s||"").normalize("NFKD").replace(/\p{Mn}/gu,"").toLowerCase().replace(/[إأآا]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي").replace(/[^\p{L}\p{N}]+/gu,"")} // same as weblume-company rules.normalize_name
const CONTACTED=()=>process.env.WEBLUME_CONTACTED_FILE||path.join(ROOT,"..","weblume-company","contacted.json");
function contactedSet(){try{const j=JSON.parse(fs.readFileSync(CONTACTED(),"utf8"));return new Set((Array.isArray(j)?j:[]).map(c=>normName(c&&c.business)).filter(Boolean))}catch(e){return null}}
// Runs in the page: Google Maps result cards (the list has no website/phone; PLACE reads those from each place page).
const MAPS=()=>[...document.querySelectorAll('div[role=feed] a[href*="/maps/place/"]')].map(a=>{const c=a.parentElement||a,name=a.getAttribute("aria-label")||"";
  const lines=(c.innerText||"").split("\n").map(x=>x.trim()).filter(x=>x&&x!==name),star=c.querySelector('[role=img][aria-label]');
  return{name,url:a.href.split("?")[0],rating:star?star.getAttribute("aria-label"):"",info:lines.slice(0,3).join(" · ").slice(0,160)}});
const PLACE=()=>{const q=s=>document.querySelector(s);const ph=q('[data-item-id^="phone:tel:"]'),site=q('a[data-item-id="authority"]'),ad=q('[data-item-id="address"]');
  return{website:site?site.href:"",phone:ph?ph.getAttribute("data-item-id").slice(10):"",address:ad?ad.innerText.replace(/\s+/g," ").trim().slice(0,160):""}};
const SOCIAL=/^https?:\/\/([\w-]+\.)*(instagram\.com|facebook\.com|fb\.com|linktr\.ee|linkfly\.to|tiktok\.com|wa\.me|whatsapp\.com|x\.com|twitter\.com|snapchat\.com|t\.me)\//i;
async function browser(b){const a=str(b.action,30);
  if(a==="open"){const u=str(b.url,1000);if(!/^https?:\/\//i.test(u))return bad(400,"الرابط لازم يبدأ بـ http أو https.");
    const p=await getPage();await p.goto(u,{waitUntil:"domcontentloaded",timeout:30000});if(captcha(p.url()))return ok("🧩 جوجل طالب كابتشا",CAPTCHA_MSG);
    const r=await readPage(p);return ok("🌐 فتحت: "+r.title,pageText(r))}
  if(a==="read"){const r=await readPage(await getPage());return ok("📖 قريت الصفحة: "+r.title,pageText(r))}
  if(a==="back"){const p=await getPage();await p.goBack({timeout:15000}).catch(()=>{});const r=await readPage(p);return ok("↩ رجعت: "+r.title,pageText(r))}
  if(a==="google_search"){const q=str(b.query,300);if(!q)return bad(400,"اكتب كلمات البحث.");const p=await getPage();
    await p.goto("https://www.google.com/search?q="+encodeURIComponent(q),{waitUntil:"domcontentloaded",timeout:30000});
    if(captcha(p.url()))return ok("🧩 جوجل طالب كابتشا",CAPTCHA_MSG);
    const rs=await p.evaluate(()=>[...document.querySelectorAll("a h3")].map(h=>{const a=h.closest("a");return{title:h.innerText.trim(),url:a.href}}).filter(x=>/^https?:/.test(x.url)&&!/google\.[a-z.]+\//.test(x.url)).slice(0,10));
    return ok("🔎 بحثت في جوجل: «"+q+"» ("+rs.length+" نتيجة)",rs.length?rs.map((x,i)=>(i+1)+". "+x.title+"\n"+x.url).join("\n\n"):"مفيش نتايج ظاهرة. استخدم read تشوف الصفحة.")}
  if(a==="maps_search"){const q=str(b.query,200);if(!q)return bad(400,"اكتب نوع المكان والمدينة، مثلا: كافيهات في جدة.");const max=Math.min(Math.max(+b.max||20,1),60);
    const p=await getPage();await p.goto("https://www.google.com/maps/search/"+encodeURIComponent(q)+"?hl=en",{waitUntil:"domcontentloaded",timeout:30000});
    if(captcha(p.url()))return ok("🧩 جوجل طالب كابتشا",CAPTCHA_MSG);
    await p.waitForSelector("div[role=feed]",{timeout:20000}).catch(()=>{});
    let list=[];for(let i=0;i<12;i++){list=await p.evaluate(MAPS);if(list.length>=max)break;
      await p.evaluate(()=>{const f=document.querySelector("div[role=feed]");if(f)f.scrollBy(0,2500)});await p.waitForTimeout(1500)}
    const seen=new Set();list=list.filter(x=>x.name&&!seen.has(x.url)&&seen.add(x.url)).slice(0,max);
    for(const x of list){await p.goto(x.url+"?hl=en",{waitUntil:"domcontentloaded",timeout:30000}).catch(()=>{});
      await p.waitForSelector("[data-item-id]",{timeout:8000}).catch(()=>{});Object.assign(x,await p.evaluate(PLACE).catch(()=>({website:"",phone:"",address:""})));
      if(SOCIAL.test(x.website)){x.social=x.website;x.website=""}}
    const done=contactedSet();for(const x of list)x.contacted=done?done.has(normName(x.name)):null;
    const noSite=list.filter(x=>!x.website);
    const result=(done?"":"⚠️ مش قادر أقرا contacted.json، فمش عارف مين اتكلمنا معاه قبل كده. ماتبعتش لحد قبل ما تسأل أسير.\n")+
      "لقيت "+list.length+" مكان، منهم "+noSite.length+" من غير موقع. اللي عليه [اتكلمنا معاه] ممنوع نبعتله تاني من غير ما نسأل أسير.\n\n"+
      list.map((x,i)=>(i+1)+". "+x.name+(x.contacted?" [اتكلمنا معاه]":"")+(x.website?" — موقع: "+x.website:" — من غير موقع"+(x.social?" (سوشيال بس: "+x.social+")":""))+(x.rating?" — "+x.rating:"")+(x.phone?" — "+x.phone:"")+(x.info?"\n   "+x.info:"")+(x.address?"\n   "+x.address:"")+"\n   "+x.url).join("\n");
    return ok("📍 جمعت "+list.length+" مكان من خرائط جوجل («"+q+"»)، "+noSite.length+" من غير موقع",result,{listings:list})}
  const n=Math.trunc(+b.n);
  if(a==="click"||a==="type"){if(!(n>0))return bad(400,"محتاج رقم العنصر n من read.");const p=await getPage();const d=await p.evaluate(DESCRIBE,n);
    if(!d)return bad(404,"العنصر رقم "+n+" مش موجود. اعمل read تاني.");const sel='[data-wl="'+n+'"]',name=(d.text||d.attrs||d.tag).slice(0,80);
    if(a==="click"){const run=async()=>{await p.click(sel,{timeout:15000});await p.waitForTimeout(800);const r=await readPage(p);return ok("🖱 ضغطت «"+name+"»",pageText(r))};
      return clickRisk(d)?ask("أضغط «"+name+"» في "+d.host+"؟ (ممكن يبعت أو يأكد حاجة)",run):run()}
    const text=typeof b.text==="string"?b.text.slice(0,2000):"";
    if(secretField(d))return bad(403,"دي خانة باسورد أو كارت أو كود. أنا ممنوع أكتب فيها، أسير يكتبها بنفسه في نافذة كروم.");
    if(SECRET_RX.test(text))return bad(403,"النص ده شكله باسورد أو مفتاح أو رقم كارت، مش هكتبه.");
    await p.fill(sel,text,{timeout:15000});
    if(!b.enter)return ok("⌨ كتبت في «"+name+"»: "+text.slice(0,80),"✅ اتكتب. لو عايز تبعته استخدم enter:true أو اضغط الزرار.");
    const go=async()=>{await p.press(sel,"Enter");await p.waitForTimeout(1200);const r=await readPage(p);return ok("⏎ كتبت «"+text.slice(0,60)+"» ودوست Enter",pageText(r))};
    return enterRisk(d)?ask("أبعت «"+text.slice(0,120)+"» (Enter) في "+d.host+"؟",go):go()}
  return bad(400,"action لازم: open, read, click, type, back, google_search, maps_search.")}

// ---- Google (Asser's own Desktop OAuth client; tokens in a git-ignored file next to the repo, never sent to the browser)
const G_CLIENT=()=>process.env.WEBLUME_GOOGLE_CLIENT||path.join(ROOT,"google-client.json");
const G_TOKEN=()=>process.env.WEBLUME_GOOGLE_TOKEN||path.join(ROOT,"google-token.json");
// cloud-platform + firebase: firebase_setup makes a project, database and sign-in for a client site (after the owner approves)
const G_SCOPES=["gmail.readonly","gmail.compose","calendar.events","drive.readonly","spreadsheets","cloud-platform","firebase"].map(s=>"https://www.googleapis.com/auth/"+s);
const gurl=(host,p)=>process.env.GOOGLE_API_BASE?process.env.GOOGLE_API_BASE+"/"+host+p:"https://"+host+p; // base override is for tests only
const b64u=b=>Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
function gClient(){try{const j=JSON.parse(fs.readFileSync(G_CLIENT(),"utf8"));const c=j.installed||j.web||j;return c.client_id&&c.client_secret?c:null}catch(e){return null}}
function gToken(){try{return JSON.parse(fs.readFileSync(G_TOKEN(),"utf8"))}catch(e){return null}}
const saveToken=t=>fs.writeFileSync(G_TOKEN(),JSON.stringify(t),{mode:0o600});
const flows=new Map();
const CONNECT_HINT=port=>"جوجل مش متوصل. افتح http://127.0.0.1:"+port+"/api/google/connect مرة واحدة ووافق.";
function gConnect(host){const c=gClient();if(!c)return{html:"<p>مفيش google-client.json في فولدر weblume-ai. اتبع خطوات README (Google services).</p>",code:503};
  const state=b64u(crypto.randomBytes(24)),verifier=b64u(crypto.randomBytes(48)),redirect="http://"+host+"/api/google/callback";
  flows.set(state,{verifier,redirect,t:Date.now()});
  const q=new URLSearchParams({client_id:c.client_id,redirect_uri:redirect,response_type:"code",scope:G_SCOPES.join(" "),access_type:"offline",prompt:"consent",state,
    code_challenge:b64u(crypto.createHash("sha256").update(verifier).digest()),code_challenge_method:"S256"});
  return{redirect:"https://accounts.google.com/o/oauth2/v2/auth?"+q}}
async function tokenCall(form){const r=await fetch(gurl("oauth2.googleapis.com","/token"),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams(form),redirect:"error"});
  return{ok:r.ok,j:await r.json().catch(()=>({}))}}
async function gCallback(qs){const f=flows.get(qs.get("state")||"");flows.delete(qs.get("state")||"");
  if(!f||Date.now()-f.t>600000)return{code:400,html:"<p>الرابط ده قديم. افتح /api/google/connect تاني.</p>"};
  if(qs.get("error"))return{code:400,html:"<p>جوجل رجّع: "+String(qs.get("error")).replace(/[<>&"]/g,"")+"</p>"};
  const c=gClient();const r=await tokenCall({code:qs.get("code")||"",client_id:c.client_id,client_secret:c.client_secret,redirect_uri:f.redirect,grant_type:"authorization_code",code_verifier:f.verifier});
  if(!r.ok||!r.j.refresh_token)return{code:502,html:"<p>جوجل مارضيش يدي توكن. جرّب تاني.</p>"};
  saveToken({refresh_token:r.j.refresh_token,access_token:r.j.access_token,scope:r.j.scope||"",expiry:Date.now()+(r.j.expires_in||3600)*1000});
  return{code:200,html:"<p>✅ جوجل اتوصل بـ Weblume AI. اقفل الصفحة دي وارجع للشات.</p>"}}
async function accessToken(port){const t=gToken(),c=gClient();if(!t||!t.refresh_token||!c)throw Object.assign(new Error(c?CONNECT_HINT(port):"مفيش google-client.json. اتبع خطوات README (Google services)."),{code:401});
  if(t.access_token&&t.expiry>Date.now()+60000)return t.access_token;
  const r=await tokenCall({refresh_token:t.refresh_token,client_id:c.client_id,client_secret:c.client_secret,grant_type:"refresh_token"});
  if(!r.ok){if(r.j.error==="invalid_grant")try{fs.unlinkSync(G_TOKEN())}catch(e){}throw Object.assign(new Error(CONNECT_HINT(port)),{code:401})}
  saveToken({...t,access_token:r.j.access_token,expiry:Date.now()+(r.j.expires_in||3600)*1000});return r.j.access_token}
async function gapi(port,method,host,p,body){const tok=await accessToken(port);
  const r=await fetch(gurl(host,p),{method,headers:{Authorization:"Bearer "+tok,...(body?{"Content-Type":"application/json"}:{})},body:body&&JSON.stringify(body),redirect:"error"});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error((r.status===401?CONNECT_HINT(port):"جوجل رفض ("+r.status+"): "+String(j.error&&j.error.message||"").slice(0,200))),{code:r.status===401?401:502});
  return j}
const sheetId=s=>{const m=String(s||"").match(/\/spreadsheets\/d\/([\w-]{20,})/)||String(s||"").match(/^([\w-]{20,})$/);return m?m[1]:""};
const hdr=(m,n)=>((m.payload&&m.payload.headers)||[]).find(h=>h.name.toLowerCase()===n.toLowerCase())?.value||"";
const unb64=s=>Buffer.from(String(s||"").replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8");
function mailText(part){if(!part)return"";if(part.mimeType==="text/plain"&&part.body&&part.body.data)return unb64(part.body.data);
  for(const x of part.parts||[]){const t=mailText(x);if(t)return t}
  if(part.mimeType==="text/html"&&part.body&&part.body.data)return unb64(part.body.data).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi,"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ");return""}
const mimeWord=s=>/^[\x20-\x7e]*$/.test(s)?s:"=?UTF-8?B?"+Buffer.from(s).toString("base64")+"?=";
// ---- Firebase: a new free (Spark) project for a client site: Firestore database, email sign-in, safe rules, web config.
// One approval runs every step; each Google long-running operation is polled until it finishes.
const FB_RULES=owner=>`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    // only the site owner, after confirming their email, can change content or read orders
    function isOwner() { return request.auth != null && request.auth.token.email == "${owner}" && request.auth.token.email_verified == true; }
    match /orders/{id} {
      allow create: if request.resource.data.keys().hasOnly(["items","total","name","phone","note","status","created"]) && request.resource.data.status == "new";
      allow read, update, delete: if isOwner();
    }
    match /{col}/{id} {
      allow read: if col != "orders";
      allow write: if isOwner();
    }
  }
}`;
async function gop(g,host,ver,op,ms){const t=Date.now();let o=op;  // wait for a Google operation
  while(o&&o.name&&!o.done){if(Date.now()-t>(ms||120000))throw Object.assign(new Error("جوجل اتأخر في إنشاء المشروع. جرّب تاني بعد شوية."),{code:504});
    await new Promise(r=>setTimeout(r,2500));o=await g("GET",host,"/"+ver+"/"+o.name)}
  if(o&&o.error)throw Object.assign(new Error("جوجل رفض: "+String(o.error.message||"").slice(0,200)),{code:502});return o}
async function firebaseSetup(b,port,g){
  const tok=gToken()||{};if(tok.scope&&!/cloud-platform/.test(tok.scope))return bad(401,"جوجل متوصل من غير صلاحية Firebase. افتح http://127.0.0.1:"+port+"/api/google/connect تاني ووافق على الصلاحيات الجديدة.");
  const name=str(b.name,40)||"site",slug=(name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"site").slice(0,20);
  const id=(/^[a-z]/.test(slug)?slug:"site-"+slug).replace(/-+$/,"")+"-"+crypto.randomBytes(3).toString("hex");
  let owner=str(b.owner_email,120);
  if(!owner){try{owner=(await g("GET","gmail.googleapis.com","/gmail/v1/users/me/profile")).emailAddress||""}catch(e){}}
  if(!/^[^@\s"]+@[^@\s"]+\.[^@\s"]+$/.test(owner))return bad(400,"محتاج إيميل صاحب الموقع (owner_email) عشان هو بس اللي يعدّل.");
  return ask("أعمل مشروع Firebase مجاني «"+id+"» في حساب جوجل بتاعك (داتابيز + تسجيل دخول بالإيميل)، وصاحب التعديل "+owner+"؟",async()=>{
    const steps=[];
    await gop(g,"cloudresourcemanager.googleapis.com","v1",await g("POST","cloudresourcemanager.googleapis.com","/v1/projects",{projectId:id,name:name.slice(0,30)}));steps.push("المشروع");
    await gop(g,"firebase.googleapis.com","v1beta1",await g("POST","firebase.googleapis.com","/v1beta1/projects/"+id+":addFirebase",{}),180000);steps.push("Firebase");
    await gop(g,"serviceusage.googleapis.com","v1",await g("POST","serviceusage.googleapis.com","/v1/projects/"+id+"/services:batchEnable",{serviceIds:["firestore.googleapis.com","identitytoolkit.googleapis.com","firebaserules.googleapis.com"]}),180000);
    await gop(g,"firestore.googleapis.com","v1",await g("POST","firestore.googleapis.com","/v1/projects/"+id+"/databases?databaseId=(default)",{type:"FIRESTORE_NATIVE",locationId:"eur3"}),180000);steps.push("الداتابيز");
    const rs=await g("POST","firebaserules.googleapis.com","/v1/projects/"+id+"/rulesets",{source:{files:[{name:"firestore.rules",content:FB_RULES(owner)}]}});
    await g("POST","firebaserules.googleapis.com","/v1/projects/"+id+"/releases",{name:"projects/"+id+"/releases/cloud.firestore",rulesetName:rs.name});steps.push("قواعد الأمان");
    let auth="✅";try{await g("POST","identitytoolkit.googleapis.com","/v2/projects/"+id+"/identityPlatform:initializeAuth",{});
      await g("PATCH","identitytoolkit.googleapis.com","/admin/v2/projects/"+id+"/config?updateMask=signIn.email.enabled,signIn.email.passwordRequired",{signIn:{email:{enabled:true,passwordRequired:true}}});steps.push("تسجيل الدخول")}
    catch(e){auth="⚠️ فعّل Email/Password بنفسك (ضغطة واحدة): https://console.firebase.google.com/project/"+id+"/authentication/providers"}
    const app=await gop(g,"firebase.googleapis.com","v1beta1",await g("POST","firebase.googleapis.com","/v1beta1/projects/"+id+"/webApps",{displayName:name.slice(0,40)}));
    const appId=app.response&&app.response.appId;const cfg=await g("GET","firebase.googleapis.com","/v1beta1/projects/"+id+"/webApps/"+appId+"/config");
    const config={apiKey:cfg.apiKey,authDomain:cfg.authDomain,projectId:cfg.projectId,storageBucket:cfg.storageBucket,messagingSenderId:cfg.messagingSenderId,appId:cfg.appId};
    return ok("🔥 Firebase جاهز: "+steps.join(" · "),"✅ اتعمل مشروع Firebase «"+id+"». تسجيل الدخول: "+auth+"\nصاحب التعديل: "+owner+" (لازم يأكد إيميله أول مرة).\n"+
      "حط الـ config ده في index.html وadmin.html (مش سر، مسموح يبقى في الموقع):\nconst firebaseConfig = "+JSON.stringify(config,null,1)+";\nلوحة Firebase: https://console.firebase.google.com/project/"+id)})}
async function google(b,port){const a=str(b.action,30);const g=(m,h,p,body)=>gapi(port,m,h,p,body);
  if(a==="firebase_setup")return await firebaseSetup(b,port,g);
  if(a==="status"){const c=!!gClient(),t=!!(gToken()||{}).refresh_token;return ok("🔗 حالة جوجل",c&&t?"✅ جوجل متوصل.":c?CONNECT_HINT(port):"مفيش google-client.json. اتبع README.")}
  if(a==="gmail_search"){const q=str(b.query,300),max=Math.min(Math.max(+b.max||10,1),20);
    const l=await g("GET","gmail.googleapis.com","/gmail/v1/users/me/messages?maxResults="+max+"&q="+encodeURIComponent(q));
    const ms=await Promise.all((l.messages||[]).map(m=>g("GET","gmail.googleapis.com","/gmail/v1/users/me/messages/"+encodeURIComponent(m.id)+"?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date")));
    return ok("📬 دوّرت في Gmail: «"+q+"» ("+ms.length+" رسالة)",ms.length?ms.map((m,i)=>(i+1)+". ["+m.id+"] "+hdr(m,"Subject")+"\n   من: "+hdr(m,"From")+" — "+hdr(m,"Date")+"\n   "+String(m.snippet||"").slice(0,200)).join("\n"):"مفيش رسايل.")}
  if(a==="gmail_read"){const id=str(b.id,100);if(!/^[\w-]+$/.test(id))return bad(400,"id غلط.");
    const m=await g("GET","gmail.googleapis.com","/gmail/v1/users/me/messages/"+id+"?format=full");
    return ok("📧 قريت رسالة: "+hdr(m,"Subject").slice(0,80),"الموضوع: "+hdr(m,"Subject")+"\nمن: "+hdr(m,"From")+"\nالتاريخ: "+hdr(m,"Date")+"\n\n"+mailText(m.payload).trim().slice(0,8000))}
  if(a==="gmail_draft"){const to=str(b.to,300),subject=str(b.subject,300).replace(/[\r\n]/g," "),body=typeof b.body==="string"?b.body.slice(0,20000):"";
    if(!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(to))return bad(400,"إيميل المستلم غلط.");
    const raw=b64u("To: "+to+"\r\nSubject: "+mimeWord(subject)+"\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"+Buffer.from(body).toString("base64"));
    await g("POST","gmail.googleapis.com","/gmail/v1/users/me/drafts",{message:{raw}});
    return ok("📝 عملت مسودة لـ "+to+": "+subject.slice(0,60),"✅ المسودة اتحفظت في Gmail (ماتبعتتش). أسير يراجعها ويبعتها بنفسه من Gmail.")}
  if(a==="calendar_list"){const days=Math.min(Math.max(+b.days||7,1),60),now=new Date();
    const j=await g("GET","www.googleapis.com","/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=50&timeMin="+encodeURIComponent(now.toISOString())+"&timeMax="+encodeURIComponent(new Date(+now+days*864e5).toISOString()));
    const ev=j.items||[];return ok("📅 قريت التقويم ("+ev.length+" موعد في "+days+" يوم)",ev.length?ev.map(e=>"- "+(e.start&&(e.start.dateTime||e.start.date))+" — "+(e.summary||"(من غير عنوان)")+(e.location?" @ "+e.location:"")).join("\n"):"مفيش مواعيد.")}
  if(a==="calendar_add"){const title=str(b.title,200),start=str(b.start,40);let end=str(b.end,40);
    if(!title||isNaN(Date.parse(start)))return bad(400,"محتاج title و start بتاريخ ووقت (مثلا 2026-11-20T15:00).");
    if(isNaN(Date.parse(end)))end=new Date(Date.parse(start)+3600000).toISOString();
    const tz=Intl.DateTimeFormat().resolvedOptions().timeZone,ev={summary:title,description:str(b.description,2000),start:{dateTime:start,timeZone:tz},end:{dateTime:end,timeZone:tz}};
    return ask("أضيف موعد «"+title+"» يوم "+start.replace("T"," ")+" في تقويم جوجل؟",async()=>{const j=await g("POST","www.googleapis.com","/calendar/v3/calendars/primary/events",ev);return ok("📅 ضفت موعد: "+title,"✅ الموعد اتضاف: "+(j.htmlLink||""))})}
  if(a==="drive_search"){const q=str(b.query,200).replace(/\\/g,"\\\\").replace(/'/g,"\\'");
    const j=await g("GET","www.googleapis.com","/drive/v3/files?pageSize=20&fields="+encodeURIComponent("files(id,name,mimeType,modifiedTime,webViewLink)")+"&q="+encodeURIComponent((q?"name contains '"+q+"' and ":"")+"trashed=false"));
    const f=j.files||[];return ok("🗂 دوّرت في Drive: «"+q+"» ("+f.length+" ملف)",f.length?f.map(x=>"- "+x.name+" ("+x.mimeType.split(".").pop()+") id="+x.id+"\n  "+(x.webViewLink||"")).join("\n"):"مفيش ملفات.")}
  if(a==="sheet_read"||a==="sheet_append"){const id=sheetId(b.sheet);if(!id)return bad(400,"محتاج رابط الشيت أو الـ id بتاعه.");const range=str(b.range,100)||(a==="sheet_read"?"A1:Z100":"A1");
    const base="/v4/spreadsheets/"+id+"/values/"+encodeURIComponent(range);
    if(a==="sheet_read"){const j=await g("GET","sheets.googleapis.com",base);const v=j.values||[];return ok("📊 قريت الشيت ("+v.length+" صف)",v.length?v.map(r=>r.join(" | ")).join("\n").slice(0,8000):"الشيت فاضي.")}
    const rows=Array.isArray(b.rows)?b.rows.filter(Array.isArray).slice(0,200).map(r=>r.slice(0,30).map(c=>String(c==null?"":c).slice(0,1000))):[];
    if(!rows.length)return bad(400,"rows لازم تبقى صفوف، مثلا [[\"كافيه نور\",\"جدة\",\"من غير موقع\"]].");
    if(rows.some(r=>r.some(c=>SECRET_RX.test(c))))return bad(403,"فيه خانة شكلها باسورد أو مفتاح أو رقم كارت، مش هكتبها.");
    const meta=await g("GET","sheets.googleapis.com","/v4/spreadsheets/"+id+"?fields=properties.title");
    return ask("أضيف "+rows.length+" صف في شيت «"+(meta.properties&&meta.properties.title||id)+"»؟ أول صف: "+rows[0].join(" | ").slice(0,150),async()=>{
      await g("POST","sheets.googleapis.com",base+":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS",{values:rows});
      return ok("📊 ضفت "+rows.length+" صف في الشيت","✅ اتضافوا.")})}
  return bad(400,"action لازم: status, gmail_search, gmail_read, gmail_draft, calendar_list, calendar_add, drive_search, sheet_read, sheet_append, firebase_setup.")}

// ---- computer: open a folder/file/app, run a named command from the whitelist, read a text file
const HANDS_FILE=()=>process.env.WEBLUME_HANDS_FILE||path.join(ROOT,"weblume-hands.json");
const DEFAULT_APPS={notepad:"notepad",calculator:"calc",explorer:"explorer",chrome:"chrome",vscode:"code",paint:"mspaint"};
const DEFAULT_CMDS={"ollama-list":{cmd:"ollama",args:["list"]},"gpu":{cmd:"nvidia-smi",args:[]},"node-version":{cmd:"node",args:["-v"]}};
function handsCfg(){let j={};try{j=JSON.parse(fs.readFileSync(HANDS_FILE(),"utf8"))||{}}catch(e){}
  return{apps:{...DEFAULT_APPS,...(j.apps||{})},commands:{...DEFAULT_CMDS,...(j.commands||{})}}}
const SAFE_OPEN=/\.(txt|md|pdf|png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|html?|css|js|json|csv|docx?|xlsx?|pptx?|zip)$/i;
const SECRET_FILE=/(^|[\\/])(\.env[^\\/]*|\.ssh|\.aws|\.git-credentials|\.npmrc|id_rsa[^\\/]*|weblume-settings\.json|google-(client|token)\.json|[^\\/]*(token|secret|credential|password|passwd|private|\.pem|\.key|\.p12|\.pfx|\.kdbx)[^\\/]*)([\\/]|$)/i;
const resolvePath=p=>{p=str(p,500).replace(/^~(?=$|[\\/])/,os.homedir());return p?path.resolve(os.homedir(),p):""};
let spawner=(cmd,args,opt)=>cp.spawn(cmd,args,opt);const setSpawner=f=>{spawner=f};
const launch=(cmd,args)=>{const c=spawner(cmd,args,{detached:true,stdio:"ignore",windowsHide:false});c.on("error",()=>{});c.unref&&c.unref()};
function runCmd(c){return new Promise(done=>{let out="";const ch=spawner(c.cmd,c.args||[],{cwd:c.cwd||os.homedir(),windowsHide:true,shell:false});
  const t=setTimeout(()=>{try{ch.kill()}catch(e){}},Math.min(+c.timeout||60000,300000));
  const add=d=>{out+=d;if(out.length>20000)out=out.slice(-20000)};ch.stdout&&ch.stdout.on("data",add);ch.stderr&&ch.stderr.on("data",add);
  ch.on("error",e=>{clearTimeout(t);done({code:-1,out:"مش قادر أشغّله: "+e.message})});ch.on("close",code=>{clearTimeout(t);done({code,out})})})}
async function computer(b){const a=str(b.action,30);
  if(a==="open_path"){const p=resolvePath(b.path);if(!p)return bad(400,"محتاج path.");let s;try{s=fs.statSync(p)}catch(e){return bad(404,"مش لاقي: "+p)}
    if(!s.isDirectory()&&!SAFE_OPEN.test(p))return bad(403,"مش هفتح الملف ده (ممكن يكون برنامج بيشتغل). أفتح فولدرات وملفات عادية بس.");
    launch(process.platform==="win32"?"explorer":"xdg-open",[p]);return ok("📂 فتحت: "+p,"✅ اتفتح على الجهاز.")}
  if(a==="open_app"){const cfg=handsCfg(),name=str(b.name,40).toLowerCase(),app=cfg.apps[name];
    if(!app)return bad(403,"البرنامج ده مش في القايمة المسموحة: "+Object.keys(cfg.apps).join(", ")+". أسير يقدر يزوّده في weblume-hands.json.");
    launch("cmd",["/c","start","",app]);return ok("🚀 فتحت "+name,"✅ اتفتح.")}
  if(a==="run_command"){const cfg=handsCfg(),name=str(b.name,60),c=cfg.commands[name];
    if(!c||typeof c.cmd!=="string")return bad(403,"الأمر ده مش في القايمة المسموحة: "+Object.keys(cfg.commands).join(", ")+". أسير يقدر يزوّده في weblume-hands.json.");
    return ask("أشغّل الأمر «"+name+"» ("+[c.cmd,...(c.args||[])].join(" ")+")؟",async()=>{const r=await runCmd(c);
      return ok("⚙ شغّلت «"+name+"» (كود "+r.code+")","كود الخروج: "+r.code+"\n"+r.out.replace(new RegExp(SECRET_RX.source,"gi"),"[مخفي]").slice(-6000))})}
  if(a==="read_file"){const p=resolvePath(b.path);if(!p)return bad(400,"محتاج path.");
    if(SECRET_FILE.test(p))return bad(403,"ده ملف مفاتيح أو باسوردات، مش هقراه.");
    let s;try{s=fs.statSync(p)}catch(e){return bad(404,"مش لاقي: "+p)}
    if(s.isDirectory()){const l=fs.readdirSync(p,{withFileTypes:true}).slice(0,200).map(d=>(d.isDirectory()?"📁 ":"📄 ")+d.name);return ok("📂 قريت فولدر: "+p,l.join("\n")||"فاضي.")}
    const buf=fs.readFileSync(p).subarray(0,100000);if(buf.includes(0))return bad(415,"ده مش ملف نصي.");
    return ok("📄 قريت: "+p+(s.size>100000?" (أول 100KB)":""),buf.toString("utf8").replace(new RegExp(SECRET_RX.source,"gi"),"[مخفي]"))}
  return bad(400,"action لازم: open_path, open_app, run_command, read_file.")}

// ---- phone over USB debugging (adb). Reads the screen as numbered elements, taps by number; a tap on anything that
// sends/pays/deletes, the Enter key, and installing an app wait for Asser's ✅ like the browser does.
const ADB=()=>process.env.ADB_PATH||[path.join(process.env.LOCALAPPDATA||"","Android","Sdk","platform-tools","adb.exe")].find(f=>fs.existsSync(f))||"adb";
const adb=(args,timeout)=>runCmd({cmd:ADB(),args,timeout:timeout||30000});
const PHONE_DIR=()=>path.join(os.homedir(),"Downloads","Phainora-phone");
let phoneNodes=[];
const KEYS={back:"KEYCODE_BACK",home:"KEYCODE_HOME",recents:"KEYCODE_APP_SWITCH",enter:"KEYCODE_ENTER",delete:"KEYCODE_DEL"};
function parseUi(xml){const out=[];
  for(const m of String(xml).matchAll(/<node\b([^>]*)>/g)){const a=m[1],g=k=>{const x=a.match(new RegExp(" "+k+'="([^"]*)"'));return x?x[1].replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#10;/g," "):""};
    const b=g("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);if(!b)continue;
    const text=g("text"),desc=g("content-desc"),click=g("clickable")==="true",edit=/EditText/.test(g("class"));
    if(!text&&!desc&&!click&&!edit)continue;
    out.push({text:text.slice(0,80),desc:desc.slice(0,80),id:g("resource-id").split("/").pop().slice(0,40),click,edit,password:g("password")==="true",
      x:Math.round((+b[1]+ +b[3])/2),y:Math.round((+b[2]+ +b[4])/2)});if(out.length>=120)break}
  return out}
async function phoneDevice(){const r=await adb(["devices"]);if(r.code===-1)return{err:"مش لاقي adb على الجهاز. ثبّت Android platform-tools أو حط مساره في ADB_PATH."};
  const lines=r.out.split(/\r?\n/).slice(1).map(l=>l.trim().split(/\s+/)).filter(x=>x[0]);
  if(!lines.length)return{err:"مفيش موبايل متوصل. وصّل الموبايل بالكابل، وشغّل «تصحيح أخطاء USB» من خيارات المطوّر."};
  if(lines.every(x=>x[1]==="unauthorized"))return{err:"الموبايل متوصل بس لسه ماوافقتش. افتح الموبايل واضغط «سماح» على رسالة تصحيح أخطاء USB."};
  return{list:lines.map(x=>x[0]+" ("+x[1]+")")}}
async function phone(b){const a=str(b.action,30);const d=await phoneDevice();if(d.err)return bad(409,d.err);
  if(a==="devices")return ok("📱 الأجهزة المتوصلة","✅ "+d.list.join("\n"));
  if(a==="read"){await adb(["shell","uiautomator","dump","/sdcard/wl-ui.xml"]);fs.mkdirSync(PHONE_DIR(),{recursive:true});const f=path.join(PHONE_DIR(),"ui.xml");
    await adb(["pull","/sdcard/wl-ui.xml",f]);let xml="";try{xml=fs.readFileSync(f,"utf8")}catch(e){return bad(502,"مقدرتش أقرا الشاشة (ممكن الشاشة مقفولة).")}
    phoneNodes=parseUi(xml);const app=(await adb(["shell","dumpsys","window"])).out.match(/mCurrentFocus=.*?\s([\w.]+)\/[\w.$]+\}/);
    return ok("👀 قريت شاشة الموبايل"+(app?" ("+app[1]+")":""),phoneNodes.map((n,i)=>"["+(i+1)+"] "+(n.edit?"✏️ ":n.click?"🔘 ":"")+(n.text||n.desc||n.id||"(بدون اسم)")).join("\n")||"الشاشة فاضية.")}
  if(a==="screenshot"){fs.mkdirSync(PHONE_DIR(),{recursive:true});const f=path.join(PHONE_DIR(),"shot-"+Date.now()+".png");
    await adb(["shell","screencap","-p","/sdcard/wl-shot.png"]);const r=await adb(["pull","/sdcard/wl-shot.png",f]);
    return r.code===0?ok("📸 صورة من الموبايل","✅ اتحفظت في: "+f):bad(502,"مقدرتش آخد صورة.")}
  if(a==="open_url"){const u=str(b.url,1000);if(!/^https?:\/\/[^\s"'`]+$/i.test(u))return bad(400,"محتاج رابط http أو https.");
    await adb(["shell","am","start","-a","android.intent.action.VIEW","-d",u]);return ok("🌐 فتحت على الموبايل: "+u,"✅ اتفتح. اعمل read عشان تشوف الشاشة.")}
  if(a==="open_app"){const p=str(b.package,120);if(!/^[a-zA-Z][\w]*(\.[\w]+)+$/.test(p))return bad(400,"محتاج اسم الباكدج (زي com.whatsapp).");
    const r=await adb(["shell","monkey","-p",p,"-c","android.intent.category.LAUNCHER","1"]);return /No activities found|Error/.test(r.out)?bad(404,"التطبيق ده مش متثبت: "+p):ok("🚀 فتحت "+p+" على الموبايل","✅ اتفتح.")}
  if(a==="tap"){const n=phoneNodes[(+b.n||0)-1];if(!n)return bad(400,"اعمل read الأول وابعت n رقم العنصر.");
    const label=n.text||n.desc||n.id,run=async()=>{await adb(["shell","input","tap",String(n.x),String(n.y)]);return ok("👆 ضغطت «"+label+"» على الموبايل","✅ اتضغط. اعمل read تاني عشان تشوف اللي حصل.")};
    return RISKY.test(label)?ask("أضغط «"+label+"» على الموبايل؟",run):run()}
  if(a==="type"){const t=str(b.text,500);if(!t)return bad(400,"محتاج text.");if(SECRET_RX.test(t))return bad(403,"ده شكله باسورد أو مفتاح، مش هكتبه.");
    if(phoneNodes.some(n=>n.password&&n.edit))return bad(403,"فيه خانة باسورد على الشاشة. الباسوردات تكتبها انت بإيدك.");
    await adb(["shell","input","text",t.replace(/ /g,"%s").replace(/(["'`\\$&|;<>()])/g,"\\$1")]);return ok("⌨ كتبت على الموبايل",/[^\x20-\x7E]/.test(t)?"⚠️ adb مابيكتبش عربي؛ اللي مش إنجليزي ممكن مايظهرش.":"✅ اتكتب.")}
  if(a==="key"){const k=KEYS[str(b.key,20)];if(!k)return bad(400,"key لازم: "+Object.keys(KEYS).join(", "));const run=async()=>{await adb(["shell","input","keyevent",k]);return ok("⌨ زرار "+b.key+" على الموبايل","✅ اتداس.")};
    return k==="KEYCODE_ENTER"?ask("أدوس Enter على الموبايل؟ (ممكن يبعت حاجة)",run):run()}
  if(a==="swipe"){const dir=str(b.direction,10),m={up:[540,1600,540,500],down:[540,500,540,1600],left:[900,1100,180,1100],right:[180,1100,900,1100]}[dir];
    if(!m)return bad(400,"direction لازم up/down/left/right.");await adb(["shell","input","swipe",...m.map(String),"300"]);return ok("👉 سحبت "+dir+" على الموبايل","✅ اتسحب.")}
  if(a==="install_apk"){const p=resolvePath(b.path);if(!p||!/\.apk$/i.test(p)||!fs.existsSync(p))return bad(400,"محتاج مسار ملف .apk موجود على اللابتوب.");
    return ask("أثبّت «"+path.basename(p)+"» على الموبايل؟",async()=>{const r=await adb(["install","-r",p],180000);return r.code===0?ok("📦 ثبّت "+path.basename(p)+" على الموبايل","✅ "+r.out.trim().slice(-300)):bad(502,"التثبيت فشل: "+r.out.trim().slice(-300))})}
  if(a==="logs"){const r=await adb(["logcat","-d","-t","300","*:W"]);return ok("📜 آخر تحذيرات وأخطاء الموبايل",r.out.replace(new RegExp(SECRET_RX.source,"gi"),"[مخفي]").slice(-6000))}
  return bad(400,"action لازم: devices, read, screenshot, open_url, open_app, tap, type, key, swipe, install_apk, logs.")}

async function handle(kind,b,port){try{
  if(kind==="phone")return await phone(b);
  if(kind==="browser")return await browser(b);if(kind==="google")return await google(b,port);if(kind==="computer")return await computer(b);if(kind==="confirm")return await confirm(b);
  return bad(404,"مش موجود.")}catch(e){return bad(e.code>=400&&e.code<600?e.code:502,String(e.message||e).split("\n")[0].slice(0,300))}}
module.exports={handle,gConnect,gCallback,setLauncher,setSpawner,clickRisk,enterRisk,secretField,normName,SECRET_FILE,parseUi};
