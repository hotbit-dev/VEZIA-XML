// Robô Coletor VÉZIADV — roda no computador do escritório (IP brasileiro).
// Busca publicações no DJEN e andamentos no PJe-JT e envia ao VÉZIADV.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSAO = "1.8.0";
const NUVEM = process.env["AGENTE_EXECUCAO"] === "nuvem";
import { iniciarCanalFiscal } from "./nfse.ts";
let maxTentativas = 5; // definido pelo VÉZIADV a cada sincronização
let modoCaptcha: "local" | "hibrido" | "ia" = "hibrido";
const LOCAL_ANTES_IA = 2; // no híbrido: erros do leitor local antes de chamar a IA
const PORTA = 4100;
const PASTA = dirname(process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe") ? import.meta.path : process.execPath);
const ARQ_CFG = join(PASTA, "veziadv-agente.json");
type Cfg = { url: string; token: string; horario: string };
let cfg: Cfg = { url: "", token: "", horario: "02:00" };
if (existsSync(ARQ_CFG)) try { cfg = { ...cfg, ...JSON.parse(readFileSync(ARQ_CFG, "utf8")) }; } catch {}
if (NUVEM) cfg = { ...cfg, url: process.env["VEZIADV_URL"] ?? cfg.url, token: process.env["VEZIADV_TOKEN"] ?? cfg.token };

const logs: string[] = [];
let logsPendentes: string[] = [], enviandoLogs = false;
let rodando = false, ultimaExecucao = "", ultimoResultado = "", statusSync = "Aguardando", statusFiscal = "Desconectado";
function log(m: string) {
  const mensagem = (cfg.token ? m.replaceAll(cfg.token, "[credencial omitida]") : m).replace(/vza_[0-9a-f]{64}|Bearer\s+\S+|AIza[\w-]+|AQ\.[\w.-]+/gi, "[credencial omitida]");
  const l = `${new Date().toISOString()} [${NUVEM ? "Nuvem" : "Local"}] ${mensagem}`.slice(0, 1000);
  logs.unshift(l); logs.length = Math.min(logs.length, 50);
  logsPendentes.push(l); logsPendentes = logsPendentes.slice(-50); console.log(l);
}
async function enviarLogs() {
  if (enviandoLogs || !cfg.url || !cfg.token || !logsPendentes.length) return;
  enviandoLogs = true;
  const lote = logsPendentes.slice();
  try {
    await api("/api/public/agente-local/logs", { method: "POST", body: JSON.stringify({ logs: lote }) });
    const enviados = new Set(lote);
    logsPendentes = logsPendentes.filter(l => !enviados.has(l));
  } catch { /* Retain at most 50 events; transport failures must not produce more events. */ }
  finally { enviandoLogs = false; }
}
setInterval(enviarLogs, 5000);
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(path: string, init?: RequestInit) {
  const r = await fetch(cfg.url.replace(/\/$/, "") + path, { ...init, signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json", "x-agente-versao": VERSAO, "x-agente-execucao": NUVEM ? "nuvem" : "local", ...(init?.headers ?? {}) } });
  if (r.status === 401) throw new Error("Token inválido. Gere um novo em Gestão da Plataforma > Configurações.");
  if (!r.ok) throw new Error(`VÉZIADV respondeu ${r.status}`);
  return r.json();
}

async function djen(uf: string, numero: string, inicio: string, fim: string) {
  const itens: unknown[] = []; const erros: string[] = [];
  for (let pagina = 1; pagina < 50; pagina++) {
    const u = new URL("https://comunicaapi.pje.jus.br/api/v1/comunicacao");
    Object.entries({ numeroOab: numero.replace(/\D/g, ""), ufOab: uf, dataDisponibilizacaoInicio: inicio, dataDisponibilizacaoFim: fim, itensPorPagina: "100", pagina: String(pagina) }).forEach(([k, v]) => u.searchParams.set(k, v));
    try {
      const r = await fetch(u, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429) { await pausa(2000 * pagina); pagina--; continue; }
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json() as { count?: number; items?: unknown[] };
      if (!j.items?.length) break;
      itens.push(...j.items);
      if (typeof j.count === "number" && itens.length >= j.count) break;
      await pausa(800);
    } catch (e) { erros.push(`DJEN falhou na página ${pagina} (${(e as Error).message}).`); break; }
  }
  return { itens, erros };
}

const HEAD_PJE = { accept: "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36", "x-grau-instancia": "1" };
type DetPje = { itensProcesso?: { data?: string; titulo?: string; documento?: boolean }[]; mensagemErro?: string; imagem?: string; tokenDesafio?: string; _bloqueado?: boolean };
const isDesafio = (j: DetPje) => !!(j._bloqueado || j.imagem || j.tokenDesafio || j.mensagemErro || !j.itensProcesso);
async function detalhes(base: string, id: number, q = ""): Promise<DetPje> {
  const d = await fetch(`${base}/${id}${q}`, { headers: HEAD_PJE, signal: AbortSignal.timeout(30000) });
  if (d.status === 403 || d.status === 401) return { _bloqueado: true };
  if (!d.ok) throw new Error(`TRT respondeu ${d.status}`);
  return d.json() as Promise<DetPje>;
}
// Leitor local do captcha (detalhes e calibração em captcha.ts).
import * as cap from "./captcha.ts";
const espera = () => pausa(2000 + Math.random() * 3000); // 2 a 5 s entre tentativas
async function pje(trt: number, cnj: string) {
  const base = `https://pje.trt${trt}.jus.br/pje-consulta-api/api/processos`;
  const num = cnj.replace(/\D/g, "").replace(/^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/, "$1-$2.$3.$4.$5.$6");
  const r = await fetch(`${base}/dadosbasicos/${num}`, { headers: HEAD_PJE, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`TRT-${trt} respondeu ${r.status}`);
  const basicos = await r.json() as { id?: number; nivelAcesso?: number }[];
  const movs: { nome: string; dataHora: string; grau: string; complemento: string }[] = [];
  for (const b of Array.isArray(basicos) ? basicos : []) {
    if (!b.id) continue;
    let j = await detalhes(base, b.id);
    // "enviadas" = respostas mandadas ao TRT (limite do card). Leituras furadas não contam.
    let enviadas = 0, falhasLocal = 0;
    for (let pedidos = 0; isDesafio(j) && enviadas < maxTentativas && pedidos < maxTentativas * 3; pedidos++) {
      if (pedidos > 0) await espera();
      const c = await (await fetch(`${base.replace(/\/processos$/, "")}/captcha?idProcesso=${b.id}`, { headers: HEAD_PJE, signal: AbortSignal.timeout(30000) })).json() as { imagem?: string; tokenDesafio?: string };
      if (!c.imagem || !c.tokenDesafio) break;
      const b64 = c.imagem.replace(/^data:[^,]+,/, "");
      const raw = Buffer.from(b64, "base64");
      const usarIa = modoCaptcha === "ia" || (modoCaptcha === "hibrido" && falhasLocal >= LOCAL_ANTES_IA);
      const tratada = usarIa ? raw : await cap.tratar(raw);
      const arq = cap.salvarAmostra(PASTA, raw, tratada);
      let resposta = "";
      if (usarIa) {
        try { resposta = String(((await api("/api/public/agente-local/captcha", { method: "POST", body: JSON.stringify({ imagem: b64 }) })) as { texto?: string }).texto ?? ""); }
        catch (e) { log(`Leitura por IA indisponível (${(e as Error).message}).`); if (modoCaptcha === "hibrido") { modoCaptcha = "local"; continue; } break; }
      } else resposta = await cap.lerTexto(tratada, () => log("Preparando leitor local de verificação (primeira vez pode demorar)…"));
      cap.stats.total++; if (usarIa) cap.stats.ia++;
      const tam = cap.configCaptcha().tamanho;
      const fonte = usarIa ? "IA" : "local";
      if (!resposta || (tam && resposta.length !== tam)) { cap.stats.descartados++; if (!usarIa) falhasLocal++; cap.registrarCsv(PASTA, arq, `${resposta} (${fonte})`, "descartado", enviadas + 1); continue; }
      enviadas++;
      j = await detalhes(base, b.id, `?tokenDesafio=${encodeURIComponent(c.tokenDesafio)}&resposta=${encodeURIComponent(resposta)}`);
      const ok = !isDesafio(j); ok ? cap.stats.aceitos++ : cap.stats.rejeitados++;
      if (!ok && !usarIa) falhasLocal++;
      cap.registrarCsv(PASTA, arq, `${resposta} (${fonte})`, ok, enviadas);
      if (ok) log(`TRT-${trt}: verificação resolvida pelo leitor ${fonte} (tentativa ${enviadas}).`);
    }
    if (isDesafio(j)) throw new Error(`TRT-${trt} pediu verificação (captcha) e não foi possível resolver agora (tenta de novo na próxima rotina)`);
    for (const m of j.itensProcesso ?? []) if (m.data && m.titulo) movs.push({ nome: m.titulo, dataHora: m.data, grau: "PJe-JT", complemento: m.documento ? "Documento" : "" });
    await pausa(1500);
  }
  return movs;
}

type Tarefas = { desativado?: boolean; horario?: string; pendente?: boolean; comandoId?: string; comandoReserva?: string; central?: boolean; escritorios?: number; periodo: { inicio: string; fim: string }; captchaTentativas?: number; captchaModo?: string; oabs: { id: string; uf: string; numero: string }[]; processos: { id: string; numero_cnj: string; trt: number }[] };
async function sincronizar(tarefas?: Tarefas) {
  if (!tarefas && verificandoComandos) return;
  if (rodando) return; if (!cfg.url || !cfg.token) { log("Configure o endereço e o token primeiro."); return; }
  rodando = true; statusSync = "Sincronizando"; ultimaExecucao = new Date().toLocaleString("pt-BR");
  try {
    cap.zerarStats();
    log("Buscando tarefas no VÉZIADV…");
    const t = tarefas ?? await api("/api/public/agente-local/tarefas") as Tarefas;
    if (t.horario) cfg.horario = t.horario;
    if (t.desativado) { statusSync = "Busca judicial desativada neste robô"; log(statusSync); return; }
    if (t.comandoId) log(`Comando recebido do VÉZIADV: ${t.oabs.length ? "buscar publicações" : "consultar processo"}.`);
    maxTentativas = Math.min(10, Math.max(1, Number(t.captchaTentativas) || 5));
    modoCaptcha = t.captchaModo === "local" || t.captchaModo === "ia" ? t.captchaModo : "hibrido";
    log(`Período ${t.periodo.inicio} a ${t.periodo.fim}; até ${maxTentativas} tentativa(s) de verificação; leitor ${({ local: "100% local", hibrido: "híbrido (local + IA)", ia: "por IA" })[modoCaptcha]}.`);
    log(`${t.oabs.length} OAB(s) e ${t.processos.length} processo(s) trabalhista(s).`);
    let totalNovas = 0, totalPrazos = 0, totalProcessos = 0, totalMovimentos = 0, totalAvisos = 0;
    const publicacoes: unknown[] = [];
    for (const o of t.oabs) {
      const r = await djen(o.uf, o.numero, t.periodo.inicio, t.periodo.fim);
      log(`DJEN OAB ${o.numero}/${o.uf}: ${r.itens.length} publicação(ões)${r.erros.length ? " — " + r.erros.join(" ") : ""}`);
      // Envia por OAB para não ultrapassar limites de escritórios grandes.
      const salvas = await api("/api/public/agente-local/resultados", { method: "POST", body: JSON.stringify({ publicacoes: [{ oab_id: o.id, data_fim: t.periodo.fim, itens: r.itens, erros: r.erros }] }) });
      totalNovas += salvas.novas; totalPrazos += salvas.prazos; totalAvisos += salvas.avisos?.length ?? 0;
      await pausa(2000);
    }
    const andamentos = []; const falhas: string[] = [];
    for (const p of t.processos) {
      try { const m = await pje(p.trt, p.numero_cnj); andamentos.push({ processo_id: p.id, movimentos: m }); log(`PJe ${p.numero_cnj}: ${m.length} andamento(s)`); }
      catch (e) { falhas.push(`${p.numero_cnj}: ${(e as Error).message}`); log(`PJe ${p.numero_cnj}: ${(e as Error).message}`); }
      await pausa(3000);
    }
    const st = cap.stats;
    if (st.total) {
      const taxa = ((st.aceitos / st.total) * 100).toFixed(1);
      log(`Captchas: ${st.total} lidos, ${st.aceitos} aceitos, ${st.rejeitados} rejeitados, ${st.descartados} descartados, ${st.ia} pela IA — acerto ${taxa}%`);

    }
    for (let i = 0; i < Math.max(1, Math.ceil(andamentos.length / 100)); i++) {
      const r = await api("/api/public/agente-local/resultados", { method: "POST", body: JSON.stringify({ publicacoes: i ? [] : publicacoes, andamentos: andamentos.slice(i * 100, i * 100 + 100), falhas: i ? [] : falhas.slice(0, 200) }) }) as { novas: number; prazos: number; processosAtualizados: number; movimentosNovos: number };
      totalNovas += r.novas; totalPrazos += r.prazos; totalProcessos += r.processosAtualizados; totalMovimentos += r.movimentosNovos;
      ultimoResultado = `${r.novas} publicação(ões) nova(s), ${r.prazos} prazo(s), ${r.processosAtualizados} processo(s) com ${r.movimentosNovos} andamento(s) novo(s).`;
      log("Enviado: " + ultimoResultado);
    }
    totalAvisos += falhas.length;
    await api("/api/public/agente-local/resultados", { method: "POST", body: JSON.stringify({ comandoId: t.comandoId, comandoReserva: t.comandoReserva, resumoFinal: { novas: totalNovas, prazos: totalPrazos, processosAtualizados: totalProcessos, movimentosNovos: totalMovimentos, escritorios: t.escritorios ?? 1, oabs: t.oabs.length, avisos: totalAvisos ? ["Ciclo concluído com avisos; confira o registro do robô e as OABs."] : [] } }) });
    statusSync = totalAvisos ? "Concluído com avisos" : "Concluído com sucesso";
    ultimoResultado = `${t.escritorios ?? 1} escritório(s), ${t.oabs.length} OAB(s), ${totalNovas} publicação(ões) nova(s), ${totalPrazos} prazo(s), ${totalProcessos} processo(s) atualizado(s), ${totalMovimentos} andamento(s) novo(s).`;
    log(`Sincronização ${statusSync.toLowerCase()} às ${new Date().toLocaleTimeString("pt-BR")}. ${ultimoResultado}`);
  } catch (e) { statusSync = "Falha na sincronização"; log("Erro: " + (e as Error).message); ultimoResultado = "Erro: " + (e as Error).message; }
  finally { rodando = false; void enviarLogs(); }
}

let ultimoDia = "";
setInterval(() => {
  const agora = new Date(); const hm = agora.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }); const dia = agora.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  if (hm === cfg.horario && ultimoDia !== dia) { ultimoDia = dia; log("Horário agendado: iniciando."); sincronizar(); }
}, 30_000);
let verificandoComandos = false;
async function verificarComandos() {
  if (!cfg.token || !cfg.url || rodando || verificandoComandos) return;
  verificandoComandos = true;
  try {
    const t = await api("/api/public/agente-local/tarefas?comandos=1") as Tarefas;
    if (t.horario) cfg.horario = t.horario;
    if (t.pendente) await sincronizar(t);
  } catch { /* Pending requests are retained on disconnection. */ }
  finally { verificandoComandos = false; }
}
setInterval(verificarComandos, 5000);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ?? c));
function pagina() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Robô Coletor VÉZIADV</title><meta http-equiv="refresh" content="10">
<style>body{font-family:Segoe UI,sans-serif;background:#f4f5f8;color:#1b2340;margin:0}header{background:#1b2a4e;color:#fff;padding:16px 24px;font-size:20px}header b{color:#e6b3bd}main{max-width:900px;margin:20px auto;padding:0 16px}.c{background:#fff;border-radius:10px;padding:16px;margin-bottom:16px;box-shadow:0 1px 3px #0002}input{width:100%;padding:8px;margin:4px 0 10px;border:1px solid #ccd;border-radius:6px;box-sizing:border-box}button{background:#7a1f35;color:#fff;border:0;padding:10px 18px;border-radius:6px;font-size:15px;cursor:pointer}button:disabled{opacity:.5}pre{background:#10162b;color:#cfe;padding:12px;border-radius:8px;max-height:420px;overflow:auto;font-size:12px}</style></head><body>
<header>VÉZIADV · <b>Robô Coletor</b> <small style="opacity:.7">v${VERSAO}</small></header><main>
<div class="c"><b>Status:</b> ${esc(statusSync)} · Agendado diariamente às <b>${esc(cfg.horario)}</b><br>NFS-e: ${esc(statusFiscal)}<br>Última execução: ${esc(ultimaExecucao || "—")}<br>${esc(ultimoResultado)}
<form method="post" action="/sync" style="margin-top:12px"><button ${rodando || !cfg.token ? "disabled" : ""}>Sincronizar agora</button></form></div>
<div class="c"><form method="post" action="/config"><b>Configuração</b><br>Endereço do VÉZIADV<input name="url" value="${esc(cfg.url)}" placeholder="https://seu-dominio.com.br">Token do robô<input name="token" value="${cfg.token ? "••••••••" : ""}" placeholder="vza_...">Horário diário<input name="horario" type="time" value="${esc(cfg.horario)}"><button>Salvar</button></form></div>
<div class="c"><b>Registro</b><pre>${esc(logs.join("\n")) || "Sem eventos ainda."}</pre></div></main></body></html>`;
}

Bun.serve({ port: NUVEM ? 4101 : PORTA, hostname: NUVEM ? "0.0.0.0" : "127.0.0.1", async fetch(req) {
  if (NUVEM) return Response.json({ ok: true, versao: VERSAO });
  const u = new URL(req.url);
  if (!["127.0.0.1:4100", "localhost:4100"].includes(u.host)) return new Response("Acesso negado", { status: 403 });
  if (req.method === "POST" && req.headers.get("origin") !== u.origin) return new Response("Origem inválida", { status: 403 });
  if (req.method === "POST" && u.pathname === "/sync") { sincronizar(); return new Response(null, { status: 303, headers: { location: "/" } }); }
  if (req.method === "POST" && u.pathname === "/config") {
    const f = await req.formData(); const tok = String(f.get("token") ?? "").trim();
    const url = String(f.get("url") ?? "").trim();
    let destino: URL;
    try { destino = new URL(url); } catch { return new Response("Endereço inválido", { status: 400 }); }
    if (destino.protocol !== "https:" || destino.username || destino.password || destino.pathname !== "/") return new Response("Use o endereço HTTPS do VÉZIADV, sem caminho.", { status: 400 });
    cfg = { url: destino.origin, token: tok.startsWith("vza_") ? tok : cfg.token, horario: /^\d{2}:\d{2}$/.test(String(f.get("horario"))) ? String(f.get("horario")) : cfg.horario };
    writeFileSync(ARQ_CFG, JSON.stringify(cfg, null, 2)); log("Configuração salva."); return new Response(null, { status: 303, headers: { location: "/" } });
  }
  return new Response(pagina(), { headers: { "content-type": "text/html; charset=utf-8" } });
} });
iniciarCanalFiscal(api, () => !!cfg.token && !!cfg.url, log, (s) => { statusFiscal = s; });
log(NUVEM ? "Robô iniciado na nuvem, sem painel local." : `Robô iniciado. Painel em http://localhost:${PORTA}`);
if (!NUVEM && process.platform === "win32") Bun.spawn(["cmd", "/c", "start", `http://localhost:${PORTA}`]);
