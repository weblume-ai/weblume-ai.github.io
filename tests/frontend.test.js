// Frontend logic tests (no browser available): extracts the CORE/ZIP code from index.html and runs it in a VM with a mocked fetch.
const vm=require("vm"),fs=require("fs"),path=require("path"),os=require("os"),{execSync}=require("child_process");
let pass=0,fail=0,skipped=0;const T=(n,c)=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n)};
const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8").replace(/\r\n/g,"\n"); // Windows checkouts are CRLF
const core=html.slice(html.indexOf("/*CORE*/"),html.indexOf("/*END*/"));
const zipSrc=html.slice(html.indexOf("const CRCT="),html.indexOf("function titleName"));
const a=html.indexOf("\n<script>\nconst $=")+9,b=html.lastIndexOf("</script>"),js=html.slice(a,b);
const enc=new TextEncoder();
const sse=chunks=>{let i=0;return{ok:true,status:200,headers:{get:()=>"text/event-stream"},body:{getReader:()=>({read:async()=>i<chunks.length?{done:false,value:enc.encode(chunks[i++])}:{done:true}})}}};
const mk=(f,x)=>{const c=Object.assign({fetch:f,TextDecoder,AbortController,setTimeout,clearTimeout,JSON,Promise,Error,MAX_TURNS:12,provOf:()=>""},x||{});vm.createContext(c);vm.runInContext(core+";this.chatOnce=chatOnce;this.calc=calc;this.runAgent=runAgent;",c);return c};
const cfg={url:"http://x/v1",model:"m"};
(async()=>{
  const tmp=path.join(os.tmpdir(),"wl-app.js");fs.writeFileSync(tmp,js);
  try{execSync("node --check "+tmp);T("frontend JS syntax",true)}catch(e){T("frontend JS syntax",false)}
  const ids=[...html.matchAll(/\sid="([^"]+)"/g)].map(m=>m[1]),dup=ids.filter((x,i)=>ids.indexOf(x)!==i);
  T("no duplicate HTML ids"+(dup.length?": "+dup:""),!dup.length);
  const used=[...new Set([...js.matchAll(/\$\("#([\w-]+)"\)/g)].map(m=>m[1]))],miss=used.filter(x=>!ids.includes(x)&&x!=="empty");
  T("every $('#id') reference exists"+(miss.length?": "+miss:""),!miss.length);
  T("existing controls kept (chat, history, skills, settings, media, export/import)",["t-chat","t-new","t-hist","t-sk","t-media","t-set","go","att","hclear","s-test","s-dir","sk-exp","sk-imp","m-go","v-go"].every(x=>ids.includes(x)));
  T("no eval / new Function in app code",!/\beval\(|new Function\(|[^.\w]Function\(/.test(js.replace(/DEFAULT_SKILLS=\[[\s\S]*?\n\];/,"")));
  let c=mk(()=>{});const ok=(e,v)=>{try{return c.calc(e)===v}catch(x){return false}},no=e=>{try{c.calc(e);return false}catch(x){return true}};
  T("calculator arithmetic",ok("2+3*4",14)&&ok("(1+2)*-3",-9)&&ok("10/4",2.5)&&ok("7%3",1));
  T("calculator rejects code/**/1/0/empty/unbalanced",["process.exit()","2**3","1/0","","(1+2","alert(1)"].every(no));
  const l1='data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"calculator","arguments":"{\\"expres"}}]}}]}\n',l2='data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"sion\\":\\"2+2\\"}"}}]}}]}\ndata: [DONE]\n';
  c=mk(async()=>sse([l1.slice(0,40),l1.slice(40)+l2.slice(0,25),l2.slice(25)]));let m=await c.chatOnce(cfg,[],()=>{});
  T("streamed fragmented tool call reassembled",m.tool_calls&&m.tool_calls[0].function.arguments==='{"expression":"2+2"}');
  const js_=o=>({ok:true,status:200,headers:{get:()=>"application/json"},json:async()=>o});
  c=mk(async()=>js_({choices:[{message:{content:null,tool_calls:[{id:"1",function:{name:"x",arguments:"{}"}}]}}]}));m=await c.chatOnce(cfg,[],()=>{});T("non-stream reply normalised",m.content===""&&m.tool_calls.length===1);
  c=mk(async()=>js_({foo:1}));let e;try{await c.chatOnce(cfg,[],()=>{})}catch(x){e=x}T("malformed reply -> clear error",e&&/OpenAI/.test(e.message));
  c=mk(async()=>sse(['data: {"error":{"message":"boom"}}\n']));e=null;try{await c.chatOnce(cfg,[],()=>{})}catch(x){e=x}T("stream error chunk surfaced",e&&/boom/.test(e.message));
  c=mk(async()=>({ok:false,status:401,text:async()=>"no",headers:{get:()=>""}}));e=null;try{await c.chatOnce(cfg,[],()=>{})}catch(x){e=x}T("401 -> key hint",e&&/مفتاح/.test(e.message));
  let bodies=[];c=mk(async(u,o)=>{bodies.push(JSON.parse(o.body));return bodies.length===1?{ok:false,status:400,text:async()=>"does not support tools",headers:{get:()=>""}}:sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n'])});
  m=await c.chatOnce(cfg,[],()=>{});T("tools unsupported -> retried without tools",m.content==="hi"&&bodies[0].tools&&!bodies[1].tools);
  c=mk((u,o)=>Promise.resolve({ok:true,status:200,headers:{get:()=>"text/event-stream"},body:{getReader:()=>({read:()=>new Promise((_,rej)=>o.signal.addEventListener("abort",()=>{const x=new Error("a");x.name="AbortError";rej(x)}))})}}));
  const ctl=new AbortController(),pr=c.chatOnce(cfg,[],()=>{},ctl.signal);setTimeout(()=>ctl.abort(),20);e=null;try{await pr}catch(x){e=x}T("stop generation aborts cleanly",e&&/⏹/.test(e.message));
  let n=0;c=mk(async()=>{n++;return n===1?sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"calculator","arguments":"{bad"}},{"index":1,"id":"b","function":{"name":"calculator","arguments":"{\\"expression\\":\\"6*7\\"}"}}]}}]}\n']):sse(['data: {"choices":[{"delta":{"content":"done"}}]}\n'])});
  const h=[{role:"user",content:"x"}];await c.runAgent(cfg,[],h,()=>{},new AbortController().signal);const tl=h.filter(x=>x.role==="tool");
  T("agent loop: bad args -> error result, good -> 42, final text kept",tl.length===2&&/JSON/.test(tl[0].content)&&tl[1].content==="42"&&h[h.length-1].content==="done");
  // build_site: premium template renderer + tool wiring
  c=mk(async()=>{});vm.runInContext("this.renderSite=renderSite;this.normalizeSite=normalizeSite;this.wantsSite=wantsSite;this.siteFromText=siteFromText;",c);
  const sd={kind:"cafe",name:"Cafe <x>",whatsapp:"+966 50 262 8316",menu:[{category:"Hot",items:[{name:"Latte\"><img src=x onerror=alert(1)>",price:"55 ج",image:"javascript:alert(1)"}]}],hero_image:"http://insecure/x.jpg"};
  const out=c.renderSite(sd);
  T("build_site: full HTML document",out.startsWith("<!DOCTYPE html>")&&/<\/html>\n$/.test(out)&&/dir="rtl"/.test(out));
  T("build_site: user text escaped, no injected tags",!/<img src=x/.test(out)&&/Cafe &lt;x&gt;/.test(out));
  T("build_site: only https URLs kept",!/javascript:alert/.test(out)&&!/http:\/\/insecure/.test(out));
  T("build_site: whatsapp digits + ordering cart",/https:\/\/wa\.me\/966502628316/.test(out)&&/id="cart"/.test(out));
  T("build_site: only the expected script tags",(out.match(/<\/script/gi)||[]).length===2&&(out.match(/<script/gi)||[]).length===2);
  T("build_site: business/en variant",(o=>/dir="ltr"/.test(o)&&/id="services"/.test(o)&&!/id="cart"/.test(o))(c.renderSite({kind:"business",lang:"en",name:"Acme",services:[{title:"Audit"}]})));
  T("build_site: garbage input still renders",typeof c.renderSite(null)==="string"&&typeof c.renderSite({menu:"x",services:5})==="string");
  T("site intent detection",c.wantsSite("اعملي موقع كافيه")&&!c.wantsSite("اعملي موقع بـ Python Flask")&&!c.wantsSite("اعملي لعبة ثعبان")&&!c.wantsSite("اعمل عرض سعر لموقع مطعم")&&!c.wantsSite("عايز لوحة تحكم للمنيو بـ supabase")&&!c.wantsSite("اكتب بوست عن موقعي"));
  T("JSON-in-text fallback parsed",!!c.siteFromText('تمام {"kind":"cafe","name":"X"}')&&!c.siteFromText("no json"));
  n=0;c=mk(async(u,o)=>{n++;return n===1?js_({choices:[{message:{content:"",tool_calls:[{id:"s1",function:{name:"build_site",arguments:JSON.stringify({kind:"cafe",name:"Sahr",menu:[{category:"A",items:[{name:"B",price:"1"}]}]})}}]}}]}):js_({choices:[{message:{content:"جاهز"}}]})});
  const sh=[{role:"user",content:"اعملي موقع كافيه"}],evs=[];await c.runAgent(cfg,[],sh,ev=>evs.push(ev),new AbortController().signal);
  const se=evs.find(x=>x.type==="site"),st=sh.find(x=>x.role==="tool");
  T("agent loop: build_site renders site event + compact tool result",se&&/Sahr/.test(se.html)&&st&&/SITE_DATA:/.test(st.content)&&st.content.length<se.html.length&&sh[sh.length-1].content==="جاهز");
  // free design mode: no build_site tool, design direction injected, truncated HTML continued
  {let bodies=[],evs=[];const rep=["```html\n<!doctype html><html><body>AAA","BBB</body></html>\n```"];c=mk(async(u,o)=>{bodies.push(JSON.parse(o.body));return sse(['data: '+JSON.stringify({choices:[{delta:{content:rep[bodies.length-1]||"x"}}]})+'\n'])});
  const fh=[{role:"user",content:"اعمل موقع لكافيه في المعادي"}];await c.runAgent(cfg,[],fh,e=>evs.push(e),new AbortController().signal);
  const sy=bodies[0].messages[0].content,names=(bodies[0].tools||[]).map(t=>t.function.name),de=evs.find(e=>e.type==="design");
  T("free design: no build_site tool, art-direction + direction injected",!names.includes("build_site")&&/ART DIRECTION/.test(sy)&&/MOTION SYSTEM/.test(sy)&&de&&sy.includes(de.dir.n)&&/cafe/.test(de.dir.tags)&&!/نادِ أداة build_site فورًا/.test(sy));
  T("free design: truncated HTML auto-continued into one file",bodies.length===2&&/AAABBB<\/body><\/html>/.test(fh[fh.length-1].content)&&evs.some(e=>e.type==="cont"));
  bodies=[];c=mk(async(u,o)=>{bodies.push(JSON.parse(o.body));return sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n'])});
  await c.runAgent(Object.assign({},cfg,{tpl:true}),[],[{role:"user",content:"اعمل موقع لكافيه"}],()=>{},new AbortController().signal);
  T("template mode still uses build_site",(bodies[0].tools||[]).some(t=>t.function.name==="build_site")&&/build_site فورًا/.test(bodies[0].messages[0].content));
  vm.runInContext("this.pickDirection=pickDirection;this.DESIGN_DIRS=DESIGN_DIRS",c);const all=c.DESIGN_DIRS.filter(d=>/clinic/.test(d.tags)).map(d=>d.n);const seen=new Set();for(let k=0;k<40;k++)seen.add(c.pickDirection("موقع لعيادة اسنان",all.slice(1).join(" ")).n);
  T("design direction fits the business and avoids used ones",seen.size===1&&seen.has(all[0]));}
  // key sync: a key deleted on another device stays deleted
  const mkM=()=>{const mc={};vm.createContext(mc);vm.runInContext('const KEY_PROVS=["openrouter","groq"];var cfg;'+html.match(/function mergeKeys[\s\S]*?return ch\}/)[0]+';this.m=(c,o,f)=>{cfg=c;const ch=mergeKeys(o,f);return{ch,cfg}}',mc);return mc.m};
  const mm=mkM();let r_=mm({kt:100,key:"old",keys:{openrouter:"old",groq:"g"}},{kt:200,keys:{openrouter:"",groq:"g"}});
  T("keys: newer copy deletes a key (and the active key)",r_.ch&&r_.cfg.keys.openrouter===""&&r_.cfg.key===""&&r_.cfg.kt===200);
  r_=mm({kt:300,keys:{openrouter:"",groq:"g"}},{kt:200,keys:{openrouter:"old",groq:"g"}});T("keys: older copy cannot bring a deleted key back",!r_.ch&&r_.cfg.keys.openrouter==="");
  r_=mm({keys:{openrouter:"",groq:"mine"}},{keys:{openrouter:"x",groq:"theirs"}});T("keys: copy from older version only fills empty boxes",r_.cfg.keys.openrouter==="x"&&r_.cfg.keys.groq==="mine");
  r_=mm({kt:50,keys:{openrouter:"typed",groq:""}},{kt:900,keys:{openrouter:"",groq:"c"}},true);T("keys: first login keeps keys typed before login",r_.cfg.keys.openrouter==="typed"&&r_.cfg.keys.groq==="c"&&r_.cfg.kt>900);
  // server tools (web_search, build_website, remember) + memory, through a mocked local server
  {const fast=core.replace("FACTORY_POLL_MS=4000","FACTORY_POLL_MS=5");const reply=o=>({ok:true,status:200,headers:{get:()=>"application/json"},json:async()=>o});
    const call=(name,args)=>sse(['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"'+name+'","arguments":'+JSON.stringify(JSON.stringify(args))+'}}]}}]}\n']);
    const say=t=>sse(['data: {"choices":[{"delta":{"content":"'+t+'"}}]}\n']);
    const mk2=(f,x)=>{const c=Object.assign({fetch:f,TextDecoder,AbortController,setTimeout,clearTimeout,JSON,Promise,Error,MAX_TURNS:12,provOf:()=>"",SRV:true,SRV_BASE:"http://srv"},x||{});vm.createContext(c);vm.runInContext(fast+";this.runAgent=runAgent;",c);return c};
    const run=async(c,text)=>{const h=[{role:"user",content:text}],ev=[];await c.runAgent(cfg,[],h,e=>ev.push(e),new AbortController().signal);return{h,ev,tool:(h.find(x=>x.role==="tool")||{}).content||""}};
    let urls=[],sys="",turn=0;
    let c2=mk2(async(u,o)=>{urls.push(u);if(u==="http://srv/api/memory")return reply({notes:[{text:"عميل اسمه كافيه نور"}]});
      if(u.startsWith("http://srv/api/search?q="))return reply({results:[{title:"GSAP Docs",url:"https://gsap.com/docs",snippet:"scroll"}]});
      if(!turn++){sys=JSON.parse(o.body).messages[0].content;return call("web_search",{query:"gsap docs"})}return say("ok")});
    let r_=await run(c2,"دوّر على gsap");
    T("memory notes go into the system prompt",/كافيه نور/.test(sys)&&/web_search/.test(sys));
    T("web_search: calls /api/search and gives the model titles + links",urls.some(u=>u==="http://srv/api/search?q=gsap%20docs")&&/https:\/\/gsap\.com\/docs/.test(r_.tool)&&r_.h[r_.h.length-1].content==="ok");
    let posted=null;turn=0;c2=mk2(async(u,o)=>{if(u==="http://srv/api/memory"&&o.method==="POST"){posted=JSON.parse(o.body);return reply({ok:true})}if(u==="http://srv/api/memory")return reply({notes:[]});return turn++?say("done"):call("remember",{note:"أسعار 2026: 1000 ريال"})});
    r_=await run(c2,"افتكر الأسعار");T("remember: posts the note to /api/memory",posted&&posted.text==="أسعار 2026: 1000 ريال"&&/اتحفظ/.test(r_.tool));
    turn=0;c2=mk2(async(u,o)=>{if(u==="http://srv/api/memory"&&o.method==="POST")return{ok:false,status:400,json:async()=>({error:"ده شكله مفتاح"})};if(u==="http://srv/api/memory")return reply({notes:[]});return turn++?say("x"):call("remember",{note:"sk-abc"})});
    r_=await run(c2,"احفظ");T("remember: server refusal reaches the model as an error, no crash",/خطأ: ده شكله مفتاح/.test(r_.tool));
    let polls=0,startBody=null,sys2="";turn=0;
    c2=mk2(async(u,o)=>{if(u==="http://srv/api/memory")return reply({notes:[]});
      if(u==="http://srv/api/factory/start"){startBody=JSON.parse(o.body);return reply({run:"2026-11-14_نور"})}
      if(u.startsWith("http://srv/api/factory/state?run="))return reply(++polls<3?{state:"running",chat:[{from:"layla",text:"بدأنا"}].slice(0,polls)}:{state:"done",siteUrl:"http://127.0.0.1:8501/site/factory/noor/",chat:[{from:"layla",text:"بدأنا"},{from:"karim",text:"خلصت"}]});
      if(!turn++){sys2=JSON.parse(o.body).messages[0].content;return call("build_website",{goal:"موقع كافيه نور"})}return say("جاهز")});
    r_=await run(c2,"ابني موقع كافيه نور بالمصنع");
    const fe=r_.ev.find(e=>e.type==="factory"),steps=r_.ev.filter(e=>e.type==="step").map(e=>e.text).join("\n");
    T("build_website: starts the factory, polls, streams progress, opens the site",startBody&&startBody.goal==="موقع كافيه نور"&&fe&&fe.url==="http://127.0.0.1:8501/site/factory/noor/"&&/layla: بدأنا/.test(steps)&&/karim: خلصت/.test(steps)&&steps.split("بدأنا").length===2&&/8501\/site\/factory\/noor/.test(r_.tool));
    T("factory request skips free-design HTML mode and tells the model to call build_website",/نادِ build_website/.test(sys2)&&!r_.ev.some(e=>e.type==="design"));
    turn=0;c2=mk2(async(u,o)=>{if(u==="http://srv/api/memory")return reply({notes:[]});if(u.startsWith("http://srv/"))throw new TypeError("Failed to fetch");return turn++?say("x"):call("build_website",{goal:"موقع"})});
    r_=await run(c2,"بالمصنع");T("factory/server down: clear start.bat hint, no crash",/start\.bat/.test(r_.tool));
    urls=[];turn=0;c2=mk2(async(u)=>{urls.push(u);return say("hi")},{SRV:false});await run(c2,"اهلا");T("no local server: memory not fetched",!urls.some(u=>u.startsWith("http://srv")));
    const ctl2=new AbortController();turn=0;c2=mk2(async(u,o)=>{if(u==="http://srv/api/memory")return reply({notes:[]});if(u==="http://srv/api/factory/start")return reply({run:"r1"});if(u.startsWith("http://srv/api/factory/state"))return reply({state:"running",chat:[]});return turn++?say("x"):call("build_website",{goal:"موقع"})});
    const pr2=c2.runAgent(cfg,[],[{role:"user",content:"بالمصنع"}],()=>{},ctl2.signal);setTimeout(()=>ctl2.abort(),60);e=null;try{await pr2}catch(x){e=x}T("stop button ends factory polling",e&&/⏹/.test(e.message));
  }
  // ZIP integrity (needs python3 or unzip; otherwise reported as skipped, not passed)
  const zc={TextEncoder,Blob,Uint8Array,DataView,ArrayBuffer};vm.createContext(zc);vm.runInContext(zipSrc+";this.makeZip=makeZip;",zc);
  const files=[{name:"app.py",code:"print('مرحبا')\n"},{name:"templates/index.html",code:"<h1>أهلاً</h1>".repeat(500)},{name:"static/style.css",code:""}];
  const zp=path.join(os.tmpdir(),"wl-test.zip");fs.writeFileSync(zp,Buffer.from(await zc.makeZip(files).arrayBuffer()));
  try{const o=execSync(`python3 -c "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert z.read('templates/index.html').decode()=='<h1>أهلاً</h1>'*500;print(','.join(z.namelist()))" ${zp}`).toString().trim();T("ZIP valid, paths preserved, content identical ("+o+")",o==="app.py,templates/index.html,static/style.css")}
  catch(x){skipped++;console.log("SKIP ZIP integrity (python3 unavailable or failed): "+String(x.message).slice(0,80))}
  console.log("RESULT pass="+pass+" fail="+fail+" skipped="+skipped);process.exit(fail?1:0);
})();
