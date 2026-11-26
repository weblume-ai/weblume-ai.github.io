"use strict";
// Weblume optional backend (Node >= 18, zero dependencies). Serves index.html and proxies image/video providers
// so API keys stay in environment variables. Provider endpoints are fixed in server/providers/*, never taken from the client.
const http=require("http"),fs=require("fs"),path=require("path"),{Readable}=require("stream");
const ROOT=path.join(__dirname,"..");
const TPL_DIR=process.env.PHAINORA_TEMPLATES||path.join(ROOT,"..","phainora-examples","_training");
(function loadEnv(){ // minimal .env reader; real environment variables win. No inline comments, one KEY=value per line.
  try{for(const l of fs.readFileSync(path.join(ROOT,".env"),"utf8").split(/\r?\n/)){
    const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);if(!m||l.trim().startsWith("#"))continue;
    let v=m[2];if(/^(["']).*\1$/.test(v))v=v.slice(1,-1);if(process.env[m[1]]===undefined)process.env[m[1]]=v}}catch(e){}
})();
const images=require("./providers/openai-images"),video=require("./providers/replicate-video"),hands=require("./hands");
const MAX_BODY=100000;
const baseHeaders={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Frame-Options":"DENY","Referrer-Policy":"no-referrer"};
const send=(res,c,b)=>{res.writeHead(c,{...baseHeaders,"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(b))};
const out=(res,r)=>send(res,r.code,r.body);
function readBody(req){return new Promise((ok,no)=>{
  if(!(req.headers["content-type"]||"").startsWith("application/json"))return no(Object.assign(new Error("Content-Type لازم application/json"),{code:415}));
  let n=0;const c=[];req.on("data",d=>{n+=d.length;if(n>MAX_BODY){no(Object.assign(new Error("الطلب كبير"),{code:413}));req.destroy()}else c.push(d)});
  req.on("end",()=>{try{const j=JSON.parse(Buffer.concat(c).toString()||"{}");ok(j&&typeof j==="object"&&!Array.isArray(j)?j:{})}catch(e){no(Object.assign(new Error("JSON غير صالح"),{code:400}))}});
  req.on("error",no)})}
// Chat relay for providers that block direct browser calls (CORS). Upstream hosts are fixed here; the client
// only chooses which of these names to use. The key comes from the browser's Authorization header (the user's own key)
// or from the env var, and is never logged or echoed back.
const LLM_UPSTREAMS={nvidia:{base:()=>process.env.LLM_NVIDIA_BASE||"https://integrate.api.nvidia.com/v1",env:"NVIDIA_API_KEY"},
  cerebras:{base:()=>process.env.LLM_CEREBRAS_BASE||"https://api.cerebras.ai/v1",env:"CEREBRAS_API_KEY"}};
const MAX_LLM_BODY=4*1024*1024;
function readRaw(req,limit){return new Promise((ok,no)=>{
  if(!(req.headers["content-type"]||"").startsWith("application/json"))return no(Object.assign(new Error("Content-Type لازم application/json"),{code:415}));
  let n=0;const c=[];req.on("data",d=>{n+=d.length;if(n>limit){no(Object.assign(new Error("الطلب كبير"),{code:413}));req.destroy()}else c.push(d)});
  req.on("end",()=>{const t=Buffer.concat(c).toString();try{const j=JSON.parse(t||"{}");if(!j||typeof j!=="object"||Array.isArray(j))throw 0;ok(JSON.stringify(j))}catch(e){no(Object.assign(new Error("JSON غير صالح"),{code:400}))}});
  req.on("error",no)})}
async function relayLLM(req,res,name,sub){
  const up=LLM_UPSTREAMS[name];if(!up)return send(res,404,{error:"مزود غير معروف."});
  const auth=String(req.headers.authorization||"");const key=/^Bearer\s+\S{8,}$/.test(auth)?auth:(process.env[up.env]?"Bearer "+process.env[up.env]:"");
  if(!key)return send(res,401,{error:"مفيش مفتاح للمزود ده."});
  const isChat=sub==="chat/completions";if(isChat&&req.method!=="POST"||!isChat&&req.method!=="GET")return send(res,405,{error:"Method غير مسموح."});
  const body=isChat?await readRaw(req,MAX_LLM_BODY):undefined;
  const ac=new AbortController(),t=setTimeout(()=>ac.abort(),600000);res.on("close",()=>ac.abort());
  let r;try{r=await fetch(up.base()+"/"+sub,{method:req.method,headers:{Authorization:key,"Content-Type":"application/json",Accept:isChat?"text/event-stream, application/json":"application/json"},body,signal:ac.signal,redirect:"error"})}
  catch(e){clearTimeout(t);return send(res,502,{error:"مش قادر أوصل لـ "+name+"."})}
  const o={...baseHeaders,"Content-Type":r.headers.get("content-type")||"application/json"};
  res.writeHead(r.status,o);if(!r.body){clearTimeout(t);return res.end()}
  Readable.fromWeb(r.body).on("error",()=>res.destroy()).on("end",()=>clearTimeout(t)).pipe(res);
}
// Local settings file: keeps the user's own API keys on this computer so they survive browser data clearing.
// Like every /api/ route, only reachable through 127.0.0.1/localhost (Host check blocks DNS rebinding); POST also needs same Origin.
const SETTINGS_FILE=()=>process.env.WEBLUME_SETTINGS_FILE||path.join(ROOT,"weblume-settings.json");
const hostOk=req=>/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host||""));
function readSettings(){try{const j=JSON.parse(fs.readFileSync(SETTINGS_FILE(),"utf8"));return j&&typeof j==="object"&&!Array.isArray(j)?j:{}}catch(e){return {}}}
function cleanSettings(b){const o={};const str=(v,n)=>typeof v==="string"?v.trim().slice(0,n):undefined;
  if(b.keys&&typeof b.keys==="object"){o.keys={};for(const k of Object.keys(b.keys).slice(0,20))if(/^[a-z]{2,20}$/.test(k)){const v=str(b.keys[k],400);if(v!==undefined)o.keys[k]=v}}
  if(b.pm&&typeof b.pm==="object"){o.pm={};for(const k of Object.keys(b.pm).slice(0,20))if(/^[a-z]{2,20}$/.test(k)){const v=str(b.pm[k],200);if(v)o.pm[k]=v}}
  if(Number.isFinite(b.kt)&&b.kt>=0)o.kt=b.kt;
  for(const k of["smart","fb","dl"])if(typeof b[k]==="boolean")o[k]=b[k];
  for(const k of["url","model"]){const v=str(b[k],300);if(v!==undefined)o[k]=v}
  return o}
// Your own hosted copy (GitHub Pages) may talk to this local server. Nothing else may.
const ALLOWED_ORIGINS=new Set(["https://weblume-ai.github.io","https://phainora-ai.pages.dev",...String(process.env.WEBLUME_ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(x=>/^https:\/\/[\w.-]+$/.test(x))]);
function corsFor(req,res){const o=req.headers.origin;if(!o||!ALLOWED_ORIGINS.has(o))return false;
  res.setHeader("Access-Control-Allow-Origin",o);res.setHeader("Vary","Origin");res.setHeader("Access-Control-Allow-Headers","Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, DELETE, OPTIONS");res.setHeader("Access-Control-Allow-Private-Network","true");res.setHeader("Access-Control-Max-Age","600");return true}
const prompt=b=>typeof b.prompt==="string"&&b.prompt.trim()&&b.prompt.length<=4000?b.prompt.trim():null;
function state(){const v=video.config();return{
  image:images.configured(),video:v.configured,videoCancel:v.configured,
  providers:{image:{provider:images.name,configured:images.configured()},video:{provider:video.name,configured:v.configured,errors:v.errors}}}}
async function streamFile(req,res,id){
  const f=await video.fileInfo(id);if(f.body)return out(res,f);
  const h={...f.headers};if(req.headers.range)h.Range=req.headers.range;
  const ac=new AbortController();res.on("close",()=>ac.abort());
  let r;try{r=await fetch(f.url,{headers:h,signal:ac.signal})}catch(e){return send(res,502,{error:"تعذر تحميل الفيديو من المزود."})}
  if(!r.ok&&r.status!==206)return send(res,502,{error:"تعذر تحميل الفيديو من المزود ("+r.status+")."});
  const ct=r.headers.get("content-type")||"",o={...baseHeaders,"Cache-Control":"private, max-age=300","Content-Type":/^video\//.test(ct)?ct:"video/mp4"};
  for(const k of["content-length","content-range","accept-ranges"]){const v=r.headers.get(k);if(v)o[k]=v}
  res.writeHead(r.status,o);Readable.fromWeb(r.body).on("error",()=>res.destroy()).pipe(res);
}
// Web search, free and keyless: DuckDuckGo's HTML results page, parsed here. SEARCH_BASE exists for tests only.
const SEARCH_BASE=()=>process.env.SEARCH_BASE||"https://html.duckduckgo.com/html/";
const unent=s=>String(s).replace(/<[^>]*>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#x27;|&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(+n)).replace(/\s+/g," ").trim();
function parseDDG(html){const out=[];
  for(const part of String(html).split(/class="result__a"/).slice(1)){
    const h=part.match(/href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);if(!h)continue;
    let u=unent(h[1]);const g=u.match(/[?&]uddg=([^&]+)/);if(g)u=decodeURIComponent(g[1]);if(u.startsWith("//"))u="https:"+u;
    if(!/^https?:\/\//.test(u)||/^https?:\/\/(\w+\.)?duckduckgo\.com\//.test(u))continue; // ads point back to duckduckgo.com/y.js
    const s=part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|td)>/);
    out.push({title:unent(h[2]).slice(0,200),url:u.slice(0,500),snippet:s?unent(s[1]).slice(0,400):""});if(out.length>=8)break}
  return out}
async function upstream(url,opt){const ac=new AbortController(),t=setTimeout(()=>ac.abort(),15000);
  try{return await fetch(url,{...opt,signal:ac.signal,redirect:"error"})}finally{clearTimeout(t)}}
async function search(q){let r;
  try{r=await upstream(SEARCH_BASE()+"?q="+encodeURIComponent(q),{headers:{"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36","Accept-Language":"ar,en;q=0.8"}})}
  catch(e){return{code:e.name==="AbortError"?504:502,body:{error:"مش قادر أوصل لمحرك البحث."}}}
  if(!r.ok)return{code:502,body:{error:"البحث مش متاح دلوقتي ("+r.status+")."}};
  return{code:200,body:{results:parseDDG(await r.text())}}}
// Weblume site factory (weblume-company/server.py on this laptop). Proxied here because it only sends CORS to GitHub Pages.
const FACTORY=()=>process.env.WEBLUME_FACTORY_URL||"http://127.0.0.1:8501";
const FACTORY_DOWN={code:503,body:{error:"مصنع المواقع مش شغال. شغّل start.bat بتاع weblume-company."}};
async function factoryCall(method,sub,body){let r;
  try{r=await upstream(FACTORY()+sub,{method,headers:body?{"Content-Type":"application/json"}:{},body:body&&JSON.stringify(body)})}catch(e){return null}
  const j=await r.json().catch(()=>({}));return{ok:r.ok,status:r.status,j}}
async function factoryStart(goal){const r=await factoryCall("POST","/api/start",{goal,mode:"whole"});if(!r)return FACTORY_DOWN;
  if(!r.ok||typeof r.j.run!=="string")return{code:r.status>=400&&r.status<500?r.status:502,body:{error:String(r.j.error||"المصنع رفض الطلب.").slice(0,300)}};
  return{code:200,body:{run:r.j.run}}}
async function factoryState(run){const r=await factoryCall("GET","/api/state?run="+encodeURIComponent(run));if(!r)return FACTORY_DOWN;
  const s=r.ok&&r.j&&r.j.run;if(!s)return{code:404,body:{error:"المهمة دي مش موجودة في المصنع."}};
  const site=String(s.site||"").replace(/\\/g,"/"); // Windows paths from Python
  return{code:200,body:{state:s.state,error:String(s.error||"").slice(0,300),site,
    siteUrl:site?FACTORY()+"/site/"+site.split("/").map(encodeURIComponent).join("/").replace(/index\.html$/,""):"",
    chat:(Array.isArray(s.chat)?s.chat:[]).slice(-300).map(c=>({from:String(c.from||""),text:String(c.text||"").slice(0,300)})),
    ask:s.ask&&s.ask.question?{question:String(s.ask.question).slice(0,300)}:null}}}
// Free photos for the sites the AI writes: the page sends each placeholder's description, we search Pixabay and send the
// picture back as a data: URL, so the finished site stays one file that works anywhere (Pixabay asks not to hotlink).
const PIXABAY_KEY=()=>process.env.PIXABAY_API_KEY||(()=>{try{const m=fs.readFileSync(path.join(ROOT,"..","weblume-company",".env"),"utf8").match(/^\s*PIXABAY_API_KEY\s*=\s*(\S+)/m);return m?m[1]:""}catch(e){return ""}})();
const PHOTO_CACHE=new Map();
async function photo(q,w){
  q=String(q||"").replace(/[^\p{L}\p{N} ,.'-]/gu," ").trim().slice(0,300);if(!q)return{code:400,body:{error:"الوصف مطلوب."}};
  const key=PIXABAY_KEY();if(!key)return{code:503,body:{error:"مفيش مفتاح Pixabay (PIXABAY_API_KEY في .env)."}};
  const ck=q+"|"+(w>700?"L":"S");if(PHOTO_CACHE.has(ck))return PHOTO_CACHE.get(ck);
  // long prompts search badly: keep the first few content words (the subject comes first in our prompts)
  const words=q.split(/[\s,]+/).filter(x=>x.length>2&&!/^(photo|photorealistic|realistic|image|wide|text|logo|with|and|the|from|into|on|in|of|at|no)$/i.test(x)).slice(0,6).join(" ");
  let hit=null;
  for(const qq of [words,words.split(" ").slice(0,3).join(" ")]){
    try{const r=await upstream("https://pixabay.com/api/?image_type=photo&safesearch=true&per_page=5&key="+encodeURIComponent(key)+"&q="+encodeURIComponent(qq),{});
      const j=r.ok?await r.json():{};if(j.hits&&j.hits.length){hit=j.hits[0];break}}catch(e){return{code:502,body:{error:"مش قادر أوصل لـ Pixabay."}}}}
  if(!hit)return{code:404,body:{error:"مفيش صورة مناسبة."}};
  let img;try{img=await upstream(w>700?hit.largeImageURL:hit.webformatURL,{})}catch(e){return{code:502,body:{error:"مش قادر أحمّل الصورة."}}}
  if(!img.ok)return{code:502,body:{error:"مش قادر أحمّل الصورة."}};
  const b=Buffer.from(await img.arrayBuffer()),out={code:200,body:{src:"data:"+(img.headers.get("content-type")||"image/jpeg")+";base64,"+b.toString("base64"),
    credit:"Photo by "+String(hit.user||"").slice(0,60)+" on Pixabay ("+String(hit.pageURL||"").slice(0,200)+")"}};
  if(PHOTO_CACHE.size>60)PHOTO_CACHE.delete(PHOTO_CACHE.keys().next().value);PHOTO_CACHE.set(ck,out);return out}
// Memory: short notes (clients, projects, preferences) in a local file. Plain text on disk, so anything that looks like a secret is refused.
const MEMORY_FILE=()=>process.env.WEBLUME_MEMORY_FILE||path.join(ROOT,"weblume-memory.json");
const MAX_NOTES=200;
const SECRET_RX=/(sk-|sk_|gsk_|nvapi-|r8_|ghp_|github_pat_|AIza|xox[abp]-|eyJ)[\w-]{8,}|[A-Za-z0-9]{32,}|password|passwd|باسورد|باسوورد|كلمة (السر|المرور)|رقم (الكارت|البطاقة|الفيزا)|\b(?:\d[ -]?){13,19}\b/i;
function readMemory(){try{const j=JSON.parse(fs.readFileSync(MEMORY_FILE(),"utf8"));return Array.isArray(j.notes)?j.notes.filter(n=>n&&typeof n.text==="string"):[]}catch(e){return []}}
function addMemory(text){
  if(typeof text!=="string"||!text.trim()||text.length>500)return{code:400,body:{error:"الملاحظة لازم تبقى نص (حتى 500 حرف)."}};
  text=text.trim();if(SECRET_RX.test(text))return{code:400,body:{error:"ده شكله مفتاح أو باسورد أو رقم كارت، مش هحفظه."}};
  const notes=readMemory();if(!notes.some(n=>n.text===text))notes.push({text,t:new Date().toISOString().slice(0,10)});
  fs.writeFileSync(MEMORY_FILE(),JSON.stringify({notes:notes.slice(-MAX_NOTES)},null,1),{mode:0o600});return{code:200,body:{ok:true}}}
// Forget: remove notes by their exact text (the chat shows the user the list and asks first, see the forget tool).
function forgetMemory(texts){
  if(!Array.isArray(texts)||!texts.length||texts.length>MAX_NOTES||!texts.every(t=>typeof t==="string"))return{code:400,body:{error:"ابعت قايمة بنصوص الملاحظات اللي هتتمسح."}};
  const drop=new Set(texts.map(t=>t.trim())),notes=readMemory(),keep=notes.filter(n=>!drop.has(n.text));
  fs.writeFileSync(MEMORY_FILE(),JSON.stringify({notes:keep},null,1),{mode:0o600});return{code:200,body:{removed:notes.length-keep.length,left:keep.length}}}
let jvSeen=0,jvWant=false,jvText=null,jvListen=0,jvEar=0,jvSay=null;
// Jarvis's hands and eyes. The listener (127.0.0.1:8788, per-run token) does the clicking; the screen goes to Gemini only when he asks to look or click
async function jvHand(action,arg,tok,confirmed=false){const w=await fetch("http://127.0.0.1:8788/do",{method:"POST",headers:{"Content-Type":"application/json","X-Jarvis-Token":tok},body:JSON.stringify({action,arg,confirmed}),signal:AbortSignal.timeout(20000)});
  if(!w.ok)throw new Error("The listener refused.");return w.json()}
// a quick look (a description, no boxes): Qwen on Groq ~1.5 s; Gemini is the backup and does the pointing for clicks
async function jvGlance(prompt,jpg){const k=(readSettings().keys||{}).groq;if(k)try{
    const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+k},signal:AbortSignal.timeout(12000),
      body:JSON.stringify({model:"qwen/qwen3.8-27b",max_tokens:220,messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:"data:image/jpeg;base64,"+jpg.toString("base64")}}]}]})});
    if(r.ok){const t=String((((await r.json()).choices||[])[0]||{}).message?.content||"").replace(/<think>[\s\S]*?<\/think>/g,"").trim();if(t)return t}}catch(e){}
  return jvVision(prompt,jpg)}
async function jvVision(prompt,jpg){const k=(readSettings().keys||{}).gemini;if(!k)throw new Error("Jarvis needs a Gemini key to see the screen.");
  // timed 2026-11-25: 3.1-flash-lite ~3.4 s and accurate boxes; 3.5-flash with thinking off ~8 s; 2.5-flash is retired, the bigger ones think for minutes
  for(const [model,effort] of [["gemini-3.1-flash-lite",null],["gemini-3.5-flash","none"],["gemini-flash-lite-latest",null]]){
    const body={model,messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:"data:image/jpeg;base64,"+jpg.toString("base64")}}]}]};if(effort)body.reasoning_effort=effort;
    try{const r=await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+k},signal:AbortSignal.timeout(30000),body:JSON.stringify(body)});
      if(r.ok){const j=await r.json();return String(((j.choices||[])[0]||{}).message?.content||"")}}catch(e){}}
  throw new Error("Gemini didn't answer.")}
const RISKY=/delete|remove|trash|send|pay|buy|purchase|checkout|order|confirm|submit|transfer|install|uninstall|sign ?out|log ?out|حذف|امسح|مسح|إرسال|ارسال|ابعت|ادفع|دفع|شراء|اشتري|تأكيد|تثبيت|خروج/i;
async function jvEyes(action,arg,tok){
  const s=await fetch("http://127.0.0.1:8788/shot",{headers:{"X-Jarvis-Token":tok},signal:AbortSignal.timeout(10000)});if(!s.ok)throw new Error("Couldn't take a screenshot.");
  const jpg=Buffer.from(await s.arrayBuffer());
  if(action==="look")return{result:await jvGlance("This is my computer screen. In two or three short English sentences, say which app and page are open and what matters on it"+(arg?" for this request: "+arg:"")+" (quote visible names, titles and field labels exactly). No lists.",jpg)};
  const t=await jvVision('On this screenshot find the element I want to click: "'+arg.replace(/"/g,"'")+'". Answer ONLY JSON: {"found":true,"label":"the visible text or name of that element","box_2d":[ymin,xmin,ymax,xmax]} with box_2d normalized 0-1000, or {"found":false,"why":"short reason"}.',jpg);
  let o={};try{o=JSON.parse(t.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/,"$1"))}catch(e){}
  const bx=o.box_2d;if(!o.found||!Array.isArray(bx)||bx.length!==4||!bx.every(v=>Number.isFinite(v)))return{result:"I can't see "+arg+" on the screen"+(o.why?": "+o.why:"")+"."};
  const pt=((bx[1]+bx[3])/2000).toFixed(4)+","+((bx[0]+bx[2])/2000).toFixed(4),label=String(o.label||arg).slice(0,80);
  if(RISKY.test(label+" "+arg))return{result:"That would click \""+label+"\". I need your yes on the screen first.",confirm:{action:"click_at",arg:pt,label:"Click «"+label+"»"}}; // a voice "yes" could come from anyone in the room
  const d=await jvHand("click_at",pt,tok);return{result:"Clicked \""+label+"\". "+(d.result||"")}}
const server=http.createServer(async(req,res)=>{
  try{
    const p=new URL(req.url,"http://x").pathname,m=req.method;
    if(p.startsWith("/api/")&&!hostOk(req))return send(res,403,{error:"Host غير مسموح."});
    const allowed=p.startsWith("/api/")&&corsFor(req,res);
    if(m==="OPTIONS"){if(!allowed)return send(res,403,{error:"Origin غير مسموح."});res.writeHead(204,baseHeaders);return res.end()}
    if(m!=="GET"&&m!=="HEAD"&&!allowed){const o=req.headers.origin;if(o&&o!=="http://"+req.headers.host&&o!=="https://"+req.headers.host)return send(res,403,{error:"Origin غير مسموح."})}
    if(m==="GET"&&(p==="/"||p==="/index.html")){res.writeHead(200,{...baseHeaders,"Content-Type":"text/html; charset=utf-8"});return res.end(fs.readFileSync(path.join(ROOT,"index.html")))}
    if(m==="GET"&&p==="/api/health")return send(res,200,state());
    const ex=p.match(/^\/examples\/([a-z0-9-]+\.(html|json))$/);
    if(m==="GET"&&ex){const f=path.join(ROOT,"examples",ex[1]);if(!fs.existsSync(f))return send(res,404,{error:"مش موجود."});
      res.writeHead(200,{...baseHeaders,"Content-Type":ex[2]==="json"?"application/json; charset=utf-8":"text/plain; charset=utf-8"});return res.end(fs.readFileSync(f))}
    if(m==="GET"&&p==="/api/photo"){const u=new URL(req.url,"http://x");const r=await photo(u.searchParams.get("q"),+u.searchParams.get("w")||800);return send(res,r.code,r.body)}
    if(p==="/api/settings"){
      if(m==="GET")return send(res,200,readSettings());
      if(m==="POST"){const cur=readSettings(),n=cleanSettings(await readBody(req));
        // a fresh browser (no keys yet, e.g. Jarvis in Edge) must not wipe the saved keys: an empty key replaces a saved one only when its settings are newer
        if(n.keys){const newer=(n.kt||0)>(cur.kt||0),ks=Object.assign({},cur.keys);for(const[k,v]of Object.entries(n.keys))if(v||newer)ks[k]=v;n.keys=ks;if(!newer)n.kt=cur.kt}
        const o=Object.assign(cur,n);
        fs.writeFileSync(SETTINGS_FILE(),JSON.stringify(o,null,1),{mode:0o600});return send(res,200,{ok:true})}
      return send(res,405,{error:"Method غير مسموح."})}
    const lm=p.match(/^\/api\/llm\/([a-z]+)\/(models|chat\/completions)$/);if(lm)return await relayLLM(req,res,lm[1],lm[2]);
    if(m==="GET"&&p==="/api/providers/video/check"){if(!video.config().configured)return send(res,503,{error:"مزود الفيديو مش مضبوط."});return out(res,await video.check())}
    if(m==="POST"&&p==="/api/images"){
      if(!images.configured())return send(res,503,{error:"مزود الصور مش مضبوط (IMAGE_API_URL و IMAGE_MODEL)."});
      const b=await readBody(req),pr=prompt(b);if(!pr)return send(res,400,{error:"الوصف مطلوب (حتى 4000 حرف)."});
      if(b.size!=null&&b.size!==""&&!/^\d{2,4}x\d{2,4}$/.test(String(b.size)))return send(res,400,{error:"المقاس لازم يبقى WxH مثل 1024x1024."});
      return out(res,await images.generate({prompt:pr,size:b.size?String(b.size):""}));
    }
    if(p==="/api/video/jobs"&&m==="POST"){
      if(!video.config().configured)return send(res,503,{error:"مزود الفيديو مش مضبوط (REPLICATE_API_TOKEN و REPLICATE_VIDEO_MODEL)."});
      const b=await readBody(req),pr=prompt(b);if(!pr)return send(res,400,{error:"الوصف مطلوب (حتى 4000 حرف)."});
      return out(res,await video.create(pr));
    }
    const j=p.match(/^\/api\/video\/jobs\/([^/]+)(\/file)?$/);
    if(j){
      const id=decodeURIComponent(j[1]);if(!video.validId(id))return send(res,400,{error:"معرّف مهمة غير صالح."});
      if(!video.config().configured)return send(res,503,{error:"مزود الفيديو مش مضبوط."});
      if(j[2]&&m==="GET")return await streamFile(req,res,id);
      if(!j[2]&&m==="GET")return out(res,await video.status(id));
      if(!j[2]&&m==="DELETE")return out(res,await video.cancel(id));
    }
    const qs=new URL(req.url,"http://x").searchParams;
    if(m==="GET"&&p==="/api/search"){const q=(qs.get("q")||"").trim();if(!q||q.length>300)return send(res,400,{error:"اكتب كلمات البحث (حتى 300 حرف)."});return out(res,await search(q))}
    if(m==="POST"&&p==="/api/factory/start"){const b=await readBody(req),g=typeof b.goal==="string"?b.goal.trim():"";
      if(!g||g.length>2000)return send(res,400,{error:"اكتب وصف الموقع (حتى 2000 حرف)."});return out(res,await factoryStart(g))}
    if(m==="GET"&&p==="/api/factory/state"){const run=qs.get("run")||"";if(!/^[^/\\?#&\s]{1,160}$/.test(run)||run.includes(".."))return send(res,400,{error:"معرّف مهمة غير صالح."});return out(res,await factoryState(run))}
    const hp=p.match(/^\/api\/hands\/(browser|google|computer|phone|confirm)$/);
    if(hp&&m==="POST"){const b=await readBody(req);return out(res,await hands.handle(hp[1],b,String(req.headers.host||"").split(":")[1]||"8787"))}
    if(m==="GET"&&(p==="/api/google/connect"||p==="/api/google/callback")){const r=p.endsWith("connect")?hands.gConnect(req.headers.host):await hands.gCallback(qs);
      if(r.redirect){res.writeHead(302,{...baseHeaders,Location:r.redirect});return res.end()}
      res.writeHead(r.code,{...baseHeaders,"Content-Type":"text/html; charset=utf-8"});return res.end('<!doctype html><meta charset="utf-8"><body dir="rtl" style="font:18px system-ui;padding:40px">'+r.html)}
    if(m==="POST"&&p==="/api/deploy"){const b=await readBody(req);return out(res,await deploy.deploy(b.site,String(b.project||"").trim().toLowerCase()))}
    // the 96 Phainora sites the local model was trained on, as starting designs: it keeps one's <head>/CSS and writes the rest
    if(m==="GET"&&p==="/api/templates"){try{return send(res,200,{list:JSON.parse(fs.readFileSync(path.join(TPL_DIR,"examples.json"),"utf8"))})}catch(e){return send(res,200,{list:[]})}}
    if(m==="GET"&&p==="/api/template"){const f=String(qs.get("file")||"");if(!/^[a-z0-9-]+\.html$/.test(f))return send(res,400,{error:"bad name"});
      try{return send(res,200,{html:fs.readFileSync(path.join(TPL_DIR,f),"utf8")})}catch(e){return send(res,404,{error:"not found"})}}
    if(p==="/api/memory"){if(m==="GET")return send(res,200,{notes:readMemory()});
      if(m==="POST"){const b=await readBody(req);return out(res,addMemory(b.text))}
      if(m==="DELETE"){const b=await readBody(req);return out(res,forgetMemory(b.texts))}
      return send(res,405,{error:"Method غير مسموح."})}
    // Jarvis's voice: Microsoft's natural voices through edge-tts (desktop/.venv); English in Ryan (British), Arabic in Andrew (multilingual)
    // GET streams from the listener, so the first words play while the rest is still being made (an <audio> src)
    if(m==="GET"&&p==="/api/tts"){const text=String(qs.get("text")||"").replace(/[؀-ۿ]+/g," ").replace(/\s+/g," ").trim().slice(0,1500);
      if(!text)return send(res,400,{error:"مفيش نص."});
      try{const w=await fetch("http://127.0.0.1:8788/tts?text="+encodeURIComponent(text),{signal:AbortSignal.timeout(30000)});
        if(w.ok&&w.body){res.writeHead(200,{...baseHeaders,"Content-Type":"audio/mpeg"});return Readable.fromWeb(w.body).pipe(res)}}catch(e){}
      return send(res,503,{error:"The voice isn't running."})}
    if(m==="POST"&&p==="/api/tts"){const b=await readBody(req),text=typeof b.text==="string"?b.text.replace(/[؀-ۿ]+/g," ").replace(/\s+/g," ").trim().slice(0,1500):""; // Jarvis speaks English only
      if(!text)return send(res,400,{error:"مفيش نص."});
      try{const w=await fetch("http://127.0.0.1:8788/tts",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text}),signal:AbortSignal.timeout(20000)}); // the listener keeps Ryan warm
        if(w.ok){res.writeHead(200,{...baseHeaders,"Content-Type":"audio/mpeg"});return res.end(Buffer.from(await w.arrayBuffer()))}}catch(e){}
      const exe=path.join(ROOT,"desktop",".venv","Scripts","edge-tts.exe");if(!fs.existsSync(exe))return send(res,503,{error:"edge-tts مش متسطب (desktop\\setup_jarvis.bat)."});
      const ar=/[؀-ۿ]/.test(text),out=path.join(require("os").tmpdir(),"jv-"+process.pid+"-"+Date.now()+".mp3");
      // execFile with an argument list (no shell); "--text=" so a reply starting with "-" is never read as an option
      const ok=await new Promise(r=>require("child_process").execFile(exe,["--voice",ar?"en-US-AndrewMultilingualNeural":"en-GB-RyanNeural","--pitch="+(ar?"-8Hz":"-6Hz"),"--text="+text,"--write-media",out],{timeout:30000,windowsHide:true},e=>r(!e)));
      if(!ok||!fs.existsSync(out))return send(res,502,{error:"الصوت مش راضي يطلع (edge-tts محتاج نت)."});
      const buf=fs.readFileSync(out);fs.unlink(out,()=>{});res.writeHead(200,{...baseHeaders,"Content-Type":"audio/mpeg"});return res.end(buf)}
    // two claps / "Hey Jarvis" (desktop/jarvis_listener.py): an open page picks the request up on its next poll; with no page, the listener opens a window
    // Jarvis's hands: open an app / site / folder, search, media keys. Run by the listener; the token file is out of a web page's reach
    // "confirmed" is set by the page only after his click on yes; the model's tool calls never carry it
    if(m==="POST"&&p==="/api/do"){const b=await readBody(req),action=String(b.action||""),arg=String(b.arg||"").slice(0,500),confirmed=b.confirmed===true;
      if(!/^(open_app|close_app|open_website|search_google|search_youtube|play_youtube|open_folder|media|look|click|click_at|type_text|press_keys|window|system|add_reminder|list_reminders|cancel_reminder|weather|hide_jarvis|move_screen)$/.test(action))return send(res,400,{error:"Unknown action."});
      let tok="";try{tok=fs.readFileSync(path.join(ROOT,"desktop",".jarvis-token"),"utf8").trim()}catch(e){return send(res,503,{error:"The Jarvis listener isn't running."})}
      try{if(action==="look"||action==="click")return send(res,200,await jvEyes(action,arg,tok));
        return send(res,200,await jvHand(action,arg,tok,confirmed))}catch(e){return send(res,503,{error:e.message||"The Jarvis listener isn't running."})}}
    // the listener's ears (Whisper on the GPU): it asks here whether the page waits for speech, and posts what it heard to /api/jarvis
    if(m==="GET"&&p==="/api/jarvis/hear"){jvEar=Date.now();return send(res,200,{listen:Date.now()<jvListen,page:Date.now()-jvSeen<4000})}
    if(p==="/api/jarvis"){if(m==="GET"){jvSeen=Date.now();if(qs.get("listen")==="1")jvListen=Date.now()+2500;
        const o={open:jvWant,text:jvText,say:jvSay,hear:Date.now()-jvEar<3000};jvWant=false;jvText=null;jvSay=null;return send(res,200,o)}
      if(m==="POST"){const b=await readBody(req);if(typeof b.say==="string"){jvSay=b.say.trim().slice(0,500);return send(res,200,{ok:true})} // a reminder
        if(typeof b.text==="string"){jvText=b.text.trim().slice(0,1000);jvListen=0;return send(res,200,{ok:true})}
        const page=Date.now()-jvSeen<4000;if(page)jvWant=true;return send(res,200,{page})}
      return send(res,405,{error:"Method غير مسموح."})}
    send(res,404,{error:"مش موجود."});
  }catch(e){send(res,e.code&&e.code>=400&&e.code<500?e.code:500,{error:e.code?e.message:"خطأ داخلي في السيرفر."})}
});
const deploy=require("./deploy.js");
module.exports={server,state};
if(require.main===module){
  const port=+process.env.PORT||8787,host=process.env.HOST||"127.0.0.1";
  // APP_WINDOW=1 (the desktop shortcuts): a Chrome app window (same keys and chats as your Chrome; Edge if no Chrome), no tabs or address bar; APP_PATH="/?jarvis" opens straight into Jarvis
  const openBrowser=()=>{if(process.env.OPEN_BROWSER!=="1")return;const ap=/^\/[\w?=&#-]*$/.test(process.env.APP_PATH||"")?process.env.APP_PATH:"",u="http://127.0.0.1:"+port+ap,cp=require("child_process");
    try{if(process.platform==="win32"&&process.env.APP_WINDOW==="1")cp.exec('start "" chrome --app="'+u+'" --window-size=1280,860',e=>{if(e)cp.exec('start "" msedge --app="'+u+'" --window-size=1280,860',e2=>{if(e2)cp.exec('start "" "'+u+'"')})});else process.platform==="win32"?cp.exec('start "" "'+u+'"'):cp.exec((process.platform==="darwin"?"open ":"xdg-open ")+u)}catch(e){}};
  server.on("error",e=>{if(e&&e.code==="EADDRINUSE"){console.log("\n  Weblume is already running in another window. Opening http://127.0.0.1:"+port+" ...\n  You can close this window.\n");openBrowser()}else{console.error("\n  Server error: "+(e&&e.message)+"\n");process.exitCode=1}});
  server.listen(port,host,()=>{const s=state();console.log("Weblume: http://"+host+":"+port);openBrowser();console.log(" images:",s.providers.image.configured?"configured":"not configured"," video:",s.providers.video.configured?"configured":"not configured",s.providers.video.errors.join("; "))});
}
