// Hands tests: browser (fake Playwright page), Google (local mock of Google's APIs), computer (fake spawn). No real Chrome/Google.
const http=require("http"),fs=require("fs"),path=require("path"),os=require("os"),{EventEmitter}=require("events");
let pass=0,fail=0;const T=(n,c)=>{c?pass++:fail++;console.log((c?"PASS ":"FAIL ")+n)};
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),"wl-hands-")),E=process.env;
E.WEBLUME_GOOGLE_CLIENT=path.join(TMP,"google-client.json");E.WEBLUME_GOOGLE_TOKEN=path.join(TMP,"google-token.json");
E.WEBLUME_CONTACTED_FILE=path.join(TMP,"contacted.json");E.WEBLUME_HANDS_FILE=path.join(TMP,"hands.json");
const {server}=require("../server/proxy"),hands=require("../server/hands");

// ---- fake browser
const B={gotos:[],clicks:[],fills:[],presses:[],url:"about:blank",describe:{}};
const page={isClosed:()=>false,url:()=>B.url,waitForLoadState:async()=>{},waitForSelector:async()=>{},waitForTimeout:async()=>{},goBack:async()=>{},
  goto:async u=>{B.gotos.push(u);B.url=B.redirect||u},click:async s=>B.clicks.push(s),fill:async(s,t)=>B.fills.push([s,t]),press:async(s,k)=>B.presses.push([s,k]),
  evaluate:async(fn,arg)=>{const s=fn.toString();
    if(s.includes('setAttribute("data-wl"'))return{url:B.url,title:"Test Page",text:"hello page",items:[{n:1,tag:"a",label:"About"},{n:2,tag:"button",label:"إرسال"}]};
    if(s.includes("autocomplete"))return B.describe[arg]||null;
    if(s.includes("a h3"))return[{title:"GSAP Docs",url:"https://gsap.com/docs"}];
    if(s.includes("scrollBy"))return;
    if(s.includes("div[role=feed]"))return[{name:"كافيه نُور",url:"https://www.google.com/maps/place/a",rating:"4.5 stars",info:"Cafe"},{name:"Bean Bar",url:"https://www.google.com/maps/place/b",rating:"",info:""},{name:"Insta Cafe",url:"https://www.google.com/maps/place/c",rating:"",info:""},{name:"Bean Bar",url:"https://www.google.com/maps/place/b",rating:"",info:""}];
    if(s.includes("authority"))return{"https://www.google.com/maps/place/b?hl=en":{website:"https://beanbar.sa/",phone:"0551112222",address:"Jeddah"},"https://www.google.com/maps/place/c?hl=en":{website:"https://www.instagram.com/insta/",phone:"",address:""}}[B.url]||{website:"",phone:"0500000000",address:"Jeddah"};
    throw new Error("unexpected evaluate")}};
let launches=0;hands.setLauncher(async()=>{launches++;return{pages:()=>[page],newPage:async()=>page,on:()=>{}}});
B.describe={1:{tag:"a",type:"",text:"About",attrs:"",autocomplete:"",submit:false,search:false,host:"example.com"},
  2:{tag:"button",type:"",text:"إرسال",attrs:"",autocomplete:"",submit:true,search:false,host:"example.com"},
  3:{tag:"input",type:"password",text:"",attrs:"pass",autocomplete:"current-password",submit:false,search:false,host:"example.com"},
  4:{tag:"textarea",type:"",text:"",attrs:"message",autocomplete:"",submit:false,search:false,host:"web.whatsapp.com"},
  5:{tag:"input",type:"text",text:"",attrs:"q Search",autocomplete:"",submit:false,search:true,host:"example.com"},
  6:{tag:"input",type:"text",text:"",attrs:"cardnumber",autocomplete:"cc-number",submit:false,search:false,host:"shop.example"}};

// ---- fake spawn
const spawned=[];hands.setSpawner((cmd,args,opt)=>{spawned.push({cmd,args,opt});const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.unref=()=>{};
  setTimeout(()=>{c.stdout.emit("data","NAME weblume\nkey ghp_abcdefghijklmnop123\n");c.emit("close",0)},5);return c});

// ---- mock Google
const G=[];const AT="ya29.MOCKACCESS123456",RT="1//MOCKREFRESH123456";
const gmock=http.createServer((q,r)=>{let b="";q.on("data",d=>b+=d);q.on("end",()=>{G.push({m:q.method,u:q.url,b,auth:q.headers.authorization});
  const j=(c,o)=>{r.writeHead(c,{"Content-Type":"application/json"});r.end(JSON.stringify(o))},u=q.url;
  if(u==="/oauth2.googleapis.com/token"){const f=new URLSearchParams(b);
    if(f.get("grant_type")==="authorization_code")return f.get("code")==="good"&&f.get("code_verifier")?j(200,{access_token:AT,refresh_token:RT,expires_in:3600}):j(400,{error:"invalid_grant"});
    return f.get("refresh_token")===RT?j(200,{access_token:AT,expires_in:3600}):j(400,{error:"invalid_grant"})}
  if(q.headers.authorization!=="Bearer "+AT)return j(401,{error:{message:"bad token"}});
  if(u.startsWith("/gmail.googleapis.com/gmail/v1/users/me/messages?"))return j(200,{messages:[{id:"m1"}]});
  if(u.startsWith("/gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=metadata"))return j(200,{id:"m1",snippet:"عايز موقع",payload:{headers:[{name:"Subject",value:"طلب موقع"},{name:"From",value:"cafe@x.com"},{name:"Date",value:"Sat"}]}});
  if(u.startsWith("/gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full"))return j(200,{id:"m1",payload:{headers:[{name:"Subject",value:"طلب موقع"}],mimeType:"multipart/alternative",parts:[{mimeType:"text/plain",body:{data:Buffer.from("أهلا، عايزين موقع").toString("base64url")}}]}});
  if(u==="/gmail.googleapis.com/gmail/v1/users/me/drafts")return j(200,{id:"d1"});
  if(u.startsWith("/www.googleapis.com/calendar/v3/calendars/primary/events?"))return j(200,{items:[{summary:"اجتماع عميل",start:{dateTime:"2026-11-20T15:00:00+03:00"}}]});
  if(u==="/www.googleapis.com/calendar/v3/calendars/primary/events")return j(200,{htmlLink:"https://calendar.google.com/e/1"});
  if(u.startsWith("/www.googleapis.com/drive/v3/files?"))return j(200,{files:[{id:"f1",name:"Leads",mimeType:"application/vnd.google-apps.spreadsheet",webViewLink:"https://docs.google.com/x"}]});
  if(u.startsWith("/sheets.googleapis.com/v4/spreadsheets/SHEET1234567890abcdefgh?fields"))return j(200,{properties:{title:"Leads tracker"}});
  if(u.startsWith("/sheets.googleapis.com/v4/spreadsheets/SHEET1234567890abcdefgh/values/"))return q.method==="GET"?j(200,{values:[["name","city"],["Noor","Jeddah"]]}):j(200,{updates:{updatedRows:1}});
  // Firebase setup: every create returns a finished operation
  if(u==="/gmail.googleapis.com/gmail/v1/users/me/profile")return j(200,{emailAddress:"owner@example.com"});
  if(q.method==="POST"&&/^\/(cloudresourcemanager|firebase|serviceusage|firestore)\.googleapis\.com\//.test(u)&&!/webApps\/[^/]+\/config/.test(u))
    return j(200,{name:"operations/op1",done:true,response:{appId:"1:23:web:45"}});
  if(u.startsWith("/firebaserules.googleapis.com/v1/projects/")&&u.endsWith("/rulesets"))return j(200,{name:"projects/p/rulesets/r1"});
  if(u.startsWith("/firebaserules.googleapis.com/"))return j(200,{});
  if(u.startsWith("/identitytoolkit.googleapis.com/"))return j(200,{});
  if(/\/webApps\/1:23:web:45\/config$/.test(u))return j(200,{apiKey:"AIzaFAKEpublicwebkey",authDomain:"x.firebaseapp.com",projectId:"x",storageBucket:"x.appspot.com",messagingSenderId:"23",appId:"1:23:web:45"});
  j(404,{error:{message:"nope"}})})});

let port;const H=()=>({Host:"127.0.0.1:"+port});
const call=(m,p,body,h)=>new Promise(ok=>{const d=body?JSON.stringify(body):"";const q=http.request({host:"127.0.0.1",port,method:m,path:p,headers:{...H(),...(body?{"Content-Type":"application/json","Content-Length":Buffer.byteLength(d)}:{}),...(h||{})}},r=>{let t="";r.on("data",x=>t+=x);r.on("end",()=>{let j={};try{j=JSON.parse(t)}catch(e){}ok({s:r.statusCode,j,t,h:r.headers})})});q.end(d)});
const hand=(k,b)=>call("POST","/api/hands/"+k,b);

(async()=>{
  await new Promise(r=>server.listen(0,"127.0.0.1",r));port=server.address().port;
  await new Promise(r=>gmock.listen(0,"127.0.0.1",r));E.GOOGLE_API_BASE="http://127.0.0.1:"+gmock.address().port;
  // risk rules
  T("risk: send/submit buttons need a yes, plain links do not",hands.clickRisk(B.describe[2])&&!hands.clickRisk(B.describe[1])&&hands.clickRisk({text:"Place order",attrs:"",submit:false,host:"x"})&&hands.clickRisk({text:"حذف",attrs:"",submit:false,host:"x"}));
  T("risk: search submit is fine, other form submits need a yes",!hands.clickRisk({text:"Go",attrs:"",submit:true,search:true,host:"x"})&&hands.clickRisk({text:"Go",attrs:"",submit:true,search:false,host:"x"}));
  T("secret fields detected (password, card, otp)",hands.secretField(B.describe[3])&&hands.secretField(B.describe[6])&&hands.secretField({type:"text",autocomplete:"one-time-code",attrs:""})&&!hands.secretField(B.describe[4]));
  T("name normalizing matches weblume-company (accents, tashkeel, alef/taa)",hands.normName("كافيه نُور")===hands.normName("كافية نور")&&hands.normName("Café Noor!")===hands.normName("cafe noor"));

  // browser
  let r=await hand("browser",{action:"open",url:"file:///C:/x"});T("browser: only http(s) links",r.s===400&&launches===0);
  r=await hand("browser",{action:"open",url:"https://example.com"});
  T("browser: open starts Chrome once, returns page text + numbered items + a chat step",r.s===200&&launches===1&&B.gotos[0]==="https://example.com"&&/hello page/.test(r.j.result)&&/\[2\] button إرسال/.test(r.j.result)&&/فتحت/.test(r.j.step));
  r=await hand("browser",{action:"click",n:1});T("browser: safe click runs right away",r.s===200&&B.clicks.length===1&&!r.j.confirm&&launches===1);
  r=await hand("browser",{action:"click",n:2});
  T("browser: click on «إرسال» asks first and does not click",r.s===200&&r.j.confirm&&r.j.confirm.id&&/إرسال/.test(r.j.confirm.text)&&B.clicks.length===1&&!r.j.result);
  const id=r.j.confirm.id;r=await hand("confirm",{id});T("browser: after yes it clicks",r.s===200&&B.clicks.length===2&&/ضغطت/.test(r.j.step));
  r=await hand("confirm",{id});T("confirm ids are one-time",r.s===410&&B.clicks.length===2);
  r=await hand("confirm",{id:"made-up"});T("unknown confirm id refused",r.s===410);
  r=await hand("browser",{action:"type",n:3,text:"hunter2"});T("browser: never types into a password field",r.s===403&&B.fills.length===0);
  r=await hand("browser",{action:"type",n:6,text:"4111"});T("browser: never types into a card field",r.s===403&&B.fills.length===0);
  r=await hand("browser",{action:"type",n:4,text:"my key sk-abcdefgh12345678"});T("browser: refuses to type secrets anywhere",r.s===403&&B.fills.length===0);
  r=await hand("browser",{action:"type",n:4,text:"أهلا، إحنا Weblume",enter:true});
  T("browser: typing a message is fine, pressing Enter to send asks first",r.s===200&&B.fills.length===1&&r.j.confirm&&B.presses.length===0);
  r=await hand("browser",{action:"type",n:5,text:"cafes",enter:true});T("browser: Enter in a search box runs right away",r.s===200&&B.presses.length===1&&!r.j.confirm);
  r=await hand("browser",{action:"click",n:99});T("browser: missing element -> 404",r.s===404);
  r=await hand("browser",{action:"google_search",query:"gsap"});T("browser: google search lists results",r.s===200&&/gsap\.com\/docs/.test(r.j.result)&&B.gotos.pop()==="https://www.google.com/search?q=gsap");
  B.redirect="https://www.google.com/sorry/index";r=await hand("browser",{action:"google_search",query:"x"});B.redirect="";
  T("browser: CAPTCHA is left to the user",r.s===200&&/كابتشا/.test(r.j.result)&&/ممنوع أحل/.test(r.j.result));
  fs.writeFileSync(E.WEBLUME_CONTACTED_FILE,JSON.stringify([{business:"كافية نور",city:"Jeddah"}]));
  r=await hand("browser",{action:"maps_search",query:"كافيهات في جدة",max:10});const L=r.j.listings||[];
  T("maps: de-duplicated listings with website/phone from each place page",r.s===200&&L.length===3&&L[1].website==="https://beanbar.sa/"&&L[1].phone==="0551112222");
  T("maps: Instagram-only counts as no website",L[2].website===""&&/instagram/.test(L[2].social)&&/2 من غير موقع/.test(r.j.step));
  T("maps: already-contacted business flagged (Arabic spelling differences)",L[0].contacted===true&&L[1].contacted===false&&/كافيه نُور \[اتكلمنا معاه\]/.test(r.j.result)&&/ممنوع نبعتله/.test(r.j.result));
  fs.writeFileSync(E.WEBLUME_CONTACTED_FILE,"{broken");r=await hand("browser",{action:"maps_search",query:"x",max:2});
  T("maps: unreadable contacted.json -> warns not to message anyone",/مش قادر أقرا contacted\.json/.test(r.j.result)&&r.j.listings[0].contacted===null);

  // google
  r=await hand("google",{action:"gmail_search",query:"x"});T("google: no client file -> README hint",r.s===401&&/README/.test(r.j.error));
  fs.writeFileSync(E.WEBLUME_GOOGLE_CLIENT,JSON.stringify({installed:{client_id:"cid.apps.googleusercontent.com",client_secret:"GOCSPX-mock"}}));
  r=await hand("google",{action:"gmail_search",query:"x"});T("google: not connected -> connect link",r.s===401&&new RegExp("127\\.0\\.0\\.1:"+port+"/api/google/connect").test(r.j.error));
  r=await call("GET","/api/google/connect");const loc=new URL(r.h.location||"http://x");
  T("connect: redirects to Google consent with PKCE, offline access, loopback redirect",r.s===302&&loc.host==="accounts.google.com"&&loc.searchParams.get("code_challenge_method")==="S256"&&loc.searchParams.get("access_type")==="offline"&&loc.searchParams.get("redirect_uri")==="http://127.0.0.1:"+port+"/api/google/callback"&&/gmail\.compose/.test(loc.searchParams.get("scope"))&&!/gmail\.send|mail\.google\.com/.test(loc.searchParams.get("scope")));
  r=await call("GET","/api/google/callback?state=wrong&code=good");T("callback: unknown state refused",r.s===400&&!fs.existsSync(E.WEBLUME_GOOGLE_TOKEN));
  r=await call("GET","/api/google/callback?state="+loc.searchParams.get("state")+"&code=good");const tk=JSON.parse(fs.readFileSync(E.WEBLUME_GOOGLE_TOKEN,"utf8"));
  T("callback: code + verifier exchanged, token saved to the local file only",r.s===200&&tk.refresh_token===RT&&!r.t.includes(RT)&&!r.t.includes(AT)&&G.some(x=>/code_verifier=/.test(x.b)));
  r=await call("GET","/api/google/callback?state="+loc.searchParams.get("state")+"&code=good");T("callback: state is one-time",r.s===400);
  fs.writeFileSync(E.WEBLUME_GOOGLE_TOKEN,JSON.stringify({...tk,expiry:0}));G.length=0;
  r=await hand("google",{action:"gmail_search",query:"موقع"});
  T("gmail_search: refreshes an expired token, lists subject/from",r.s===200&&G[0].u==="/oauth2.googleapis.com/token"&&/grant_type=refresh_token/.test(G[0].b)&&/\[m1\] طلب موقع/.test(r.j.result)&&/cafe@x\.com/.test(r.j.result));
  r=await hand("google",{action:"gmail_read",id:"m1"});T("gmail_read: decodes the text body",r.s===200&&/أهلا، عايزين موقع/.test(r.j.result));
  r=await hand("google",{action:"gmail_read",id:"../x"});T("gmail_read: bad id refused",r.s===400);
  G.length=0;r=await hand("google",{action:"gmail_draft",to:"cafe@x.com",subject:"موقع لكافيه نور",body:"أهلا"});const raw=Buffer.from(JSON.parse(G[0].b).message.raw,"base64url").toString();
  T("gmail_draft: creates a draft (never sends), UTF-8 subject/body",r.s===200&&G.length===1&&G[0].u.endsWith("/drafts")&&/To: cafe@x\.com/.test(raw)&&/=\?UTF-8\?B\?/.test(raw)&&Buffer.from(raw.split("\r\n\r\n")[1],"base64").toString()==="أهلا"&&/ماتبعتتش/.test(r.j.result));
  T("gmail_draft: bad recipient refused",(await hand("google",{action:"gmail_draft",to:"a@b.com\r\nBcc: x@y.com",subject:"s"})).s===400);
  r=await hand("google",{action:"calendar_list",days:7});T("calendar_list: lists events",r.s===200&&/اجتماع عميل/.test(r.j.result));
  G.length=0;r=await hand("google",{action:"calendar_add",title:"مكالمة كافيه نور",start:"2026-11-20T15:00"});
  T("calendar_add: asks first, nothing written yet",r.s===200&&r.j.confirm&&/مكالمة كافيه نور/.test(r.j.confirm.text)&&!G.some(x=>x.m==="POST"));
  r=await hand("confirm",{id:r.j.confirm.id});const ev=JSON.parse(G.find(x=>x.m==="POST").b);
  T("calendar_add: after yes, event added with 1h default and local timezone",r.s===200&&ev.summary==="مكالمة كافيه نور"&&Date.parse(ev.end.dateTime)-Date.parse(ev.start.dateTime)===3600000&&!!ev.start.timeZone);
  r=await hand("google",{action:"drive_search",query:"Lead's"});T("drive_search: lists files, quotes escaped",r.s===200&&/Leads/.test(r.j.result)&&G.some(x=>decodeURIComponent(x.u).includes("name contains 'Lead\\'s'")));
  r=await hand("google",{action:"sheet_read",sheet:"https://docs.google.com/spreadsheets/d/SHEET1234567890abcdefgh/edit#gid=0"});T("sheet_read: reads rows from a sheet link",r.s===200&&/Noor \| Jeddah/.test(r.j.result));
  G.length=0;r=await hand("google",{action:"sheet_append",sheet:"SHEET1234567890abcdefgh",rows:[["Bean Bar","Jeddah","no website"]]});
  T("sheet_append: asks first and names the sheet",r.s===200&&r.j.confirm&&/Leads tracker/.test(r.j.confirm.text)&&!G.some(x=>x.m==="POST"));
  r=await hand("confirm",{id:r.j.confirm.id});const ap=G.find(x=>x.m==="POST");
  T("sheet_append: after yes, rows appended as RAW (no formulas)",r.s===200&&/valueInputOption=RAW/.test(ap.u)&&JSON.parse(ap.b).values[0][0]==="Bean Bar");
  T("sheet_append: secrets refused",(await hand("google",{action:"sheet_append",sheet:"SHEET1234567890abcdefgh",rows:[["password hunter2"]]})).s===403);
  G.length=0;r=await hand("google",{action:"firebase_setup",name:"Noor Cafe"});
  T("firebase_setup: asks first, names the project and the owner, creates nothing yet",r.s===200&&r.j.confirm&&/noor-cafe-[0-9a-f]{6}/.test(r.j.confirm.text)&&/owner@example\.com/.test(r.j.confirm.text)&&!G.some(x=>x.m==="POST"));
  r=await hand("confirm",{id:r.j.confirm.id});
  const fdb=G.find(x=>x.u.includes("/databases?databaseId=")),frs=G.find(x=>x.u.endsWith("/rulesets"));
  T("firebase_setup: after yes, Firestore + rules (owner only, email verified) + config back",r.s===200&&/firebaseConfig/.test(r.j.result)&&/1:23:web:45/.test(r.j.result)
    &&JSON.parse(fdb.b).type==="FIRESTORE_NATIVE"&&/owner@example\.com/.test(frs.b)&&/email_verified == true/.test(JSON.parse(frs.b).source.files[0].content)
    &&/allow read: if col != \\"orders\\"/.test(frs.b));
  T("firebase_setup: a bad owner email is refused",(await hand("google",{action:"firebase_setup",name:"x",owner_email:"not-an-email"})).s===400);
  fs.writeFileSync(E.WEBLUME_GOOGLE_TOKEN,JSON.stringify({refresh_token:"1//revoked123456",access_token:"",expiry:0}));
  r=await hand("google",{action:"calendar_list"});T("google: revoked token -> connect link again, token file removed",r.s===401&&/connect/.test(r.j.error)&&!fs.existsSync(E.WEBLUME_GOOGLE_TOKEN));

  // computer
  const dir=path.join(TMP,"proj");fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"notes.txt"),"client Noor\napi sk-abcdefgh12345678\n");fs.writeFileSync(path.join(dir,"setup.exe"),"MZ");fs.writeFileSync(path.join(dir,"img.bin"),Buffer.from([1,0,2]));
  r=await hand("computer",{action:"open_path",path:dir});T("open_path: opens a folder in Explorer",r.s===200&&spawned.pop().args[0]===dir);
  r=await hand("computer",{action:"open_path",path:path.join(dir,"setup.exe")});T("open_path: refuses programs",r.s===403&&!spawned.length);
  r=await hand("computer",{action:"open_app",name:"notepad"});const sp=spawned.pop();T("open_app: whitelisted app via start",r.s===200&&sp.cmd==="cmd"&&sp.args.join(" ")==="/c start  notepad");
  r=await hand("computer",{action:"open_app",name:"powershell"});T("open_app: not in the list -> refused with the list",r.s===403&&/notepad/.test(r.j.error)&&!spawned.length);
  r=await hand("computer",{action:"run_command",name:"rm -rf /"});T("run_command: only names from the whitelist",r.s===403&&!spawned.length);
  fs.writeFileSync(E.WEBLUME_HANDS_FILE,JSON.stringify({commands:{"git-status":{cmd:"git",args:["status"],cwd:dir}}}));
  r=await hand("computer",{action:"run_command",name:"git-status"});T("run_command: asks first, nothing runs yet",r.s===200&&r.j.confirm&&/git status/.test(r.j.confirm.text)&&!spawned.length);
  const cid=r.j.confirm.id;T("computer: unknown action -> 400",(await hand("computer",{action:"confirm"})).s===400);
  r=await hand("confirm",{id:cid});const rc=spawned.pop();
  T("run_command: after yes runs without a shell in its folder, output with tokens hidden",r.s===200&&rc.cmd==="git"&&rc.opt.shell===false&&rc.opt.cwd===dir&&/weblume/.test(r.j.result)&&!/ghp_/.test(r.j.result)&&/\[مخفي\]/.test(r.j.result));
  r=await hand("computer",{action:"read_file",path:path.join(dir,"notes.txt")});T("read_file: reads text, hides keys",r.s===200&&/client Noor/.test(r.j.result)&&!/sk-abc/.test(r.j.result));
  let blocked=0;for(const f of[".env","google-token.json","weblume-settings.json","my-secrets.txt",path.join(".ssh","id_rsa")])if((await hand("computer",{action:"read_file",path:path.join(dir,f)})).s===403)blocked++;
  T("read_file: key/token/password files refused",blocked===5);
  T("read_file: binary refused, folder listed",(await hand("computer",{action:"read_file",path:path.join(dir,"img.bin")})).s===415&&/notes\.txt/.test((await hand("computer",{action:"read_file",path:dir})).j.result));

  // access
  T("hands: foreign Host / foreign Origin refused",(await call("POST","/api/hands/computer",{action:"read_file",path:dir},{Host:"evil.example"})).s===403&&(await call("POST","/api/hands/computer",{action:"read_file",path:dir},{Origin:"https://evil.example"})).s===403);
  T("hands: GET not allowed",(await call("GET","/api/hands/computer")).s===404);

  console.log("RESULT pass="+pass+" fail="+fail);server.close();gmock.close();fs.rmSync(TMP,{recursive:true,force:true});process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(1)});
