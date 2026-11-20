// Publish a folder of this laptop to Cloudflare Pages (free, link <project>.pages.dev) with wrangler, Cloudflare's own
// tool (--force: the classic Pages with a pages.dev link; wrangler 4.15x otherwise moves it to Workers). Only web files are copied to a temporary folder first, so a .env, keys, settings or memory are never uploaded.
// The key comes from .env (CLOUDFLARE_API_TOKEN with "Cloudflare Pages: Edit", CLOUDFLARE_ACCOUNT_ID); the chat asks the
// owner before every publish.
//   node server/deploy.js self   -> publishes Phainora AI itself (index.html) as phainora-ai.pages.dev
const fs = require("fs"), path = require("path"), os = require("os"), { execFile } = require("child_process");
const ROOT = path.join(__dirname, ".."), PROJECTS = path.resolve(ROOT, "..");
const WRANGLER = "wrangler@4.155.0";
const WEB = /\.(html?|css|m?js|json|webmanifest|txt|xml|svg|png|jpe?g|webp|avif|gif|ico|mp4|webm|mp3|m4a|wav|woff2?|ttf|otf|pdf)$/i;
const SKIP = /^(\.|node_modules$|server$|tests$|training$|graphify-out$)|(^|[-_.])(env|secret|key|token|settings|memory)([-_.]|$)/i;
const NAME = /^[a-z0-9][a-z0-9-]{0,56}$/;

function configured() { return !!(process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) }

// a site name from the factory (weblume-company/output/<name>) or a folder inside Downloads/Projects
function resolveDir(p) {
  if (typeof p !== "string" || !p.trim() || p.length > 300) return null;
  const c = [path.resolve(PROJECTS, "weblume-company", "output", p.trim()), path.resolve(PROJECTS, p.trim())];
  return c.find(d => (d + path.sep).startsWith(PROJECTS + path.sep) && fs.existsSync(path.join(d, "index.html"))) || null;
}

function copyWeb(src, dst, n = { files: 0 }) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.test(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyWeb(s, d, n);
    else if (e.isFile() && WEB.test(e.name) && ++n.files <= 5000) fs.copyFileSync(s, d);
  }
  return n.files;
}

function wrangler(args) {
  return new Promise(ok => execFile(process.platform === "win32" ? "npx.cmd" : "npx", ["--yes", WRANGLER, ...args],
    { env: { ...process.env, CI: "1" }, timeout: 300000, maxBuffer: 8 << 20, shell: process.platform === "win32" },
    (err, out, errOut) => ok({ err, text: String(out || "") + String(errOut || "") })));
}

async function deploy(dir, project) {
  if (!configured()) return { code: 503, body: { error: "مفتاح Cloudflare Pages مش متحط: حط CLOUDFLARE_API_TOKEN وCLOUDFLARE_ACCOUNT_ID في ملف .env بتاع weblume-ai." } };
  if (!NAME.test(project || "")) return { code: 400, body: { error: "اسم المشروع: حروف إنجليزي صغيرة وأرقام وشرطة بس (يبقى اللينك name.pages.dev)." } };
  const src = typeof dir === "string" && path.isAbsolute(dir) ? dir : resolveDir(dir);
  if (!src) return { code: 404, body: { error: "مش لاقي فولدر الموقع (لازم يكون فيه index.html جوه Downloads/Projects)." } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
  try {
    const files = copyWeb(src, tmp);
    await wrangler(["pages", "project", "create", project, "--production-branch", "main", "--force"]);  // fails harmlessly when it exists
    const r = await wrangler(["pages", "deploy", tmp, "--project-name", project, "--branch", "main", "--commit-dirty=true", "--force"]);
    const url = (r.text.match(/https:\/\/[\w.-]+\.pages\.dev/g) || []).pop();
    if (r.err || !url) return { code: 502, body: { error: "Cloudflare رفض الرفع: " + r.text.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-4).join(" ").slice(0, 300) } };
    return { code: 200, body: { url: "https://" + project + ".pages.dev", preview: url, files } };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
}

module.exports = { deploy, configured, resolveDir, copyWeb };

if (require.main === module && process.argv[2] === "self") {
  require("./proxy.js");  // loads .env
  const one = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  fs.copyFileSync(path.join(ROOT, "index.html"), path.join(one, "index.html"));
  deploy(one, "phainora-ai").then(r => { console.log(r.code === 200 ? "Published: " + r.body.url : "Failed: " + r.body.error); fs.rmSync(one, { recursive: true, force: true }); process.exit(r.code === 200 ? 0 : 1) });
}
