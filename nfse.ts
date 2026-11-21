import https from "node:https";
import { gzipSync, gunzipSync } from "node:zlib";
import { dpsJaProcessada, recuperarNotaProcessada } from "./nfse-recuperacao";
import { validarRetornoFiscal } from "./nfse-fila";

type Job = { id: string; reserva: string; xml: string; chavePem: string; certPem: string; recuperar: boolean };
type Api = (path: string, init?: RequestInit) => Promise<any>;
const URL_PORTAL = "https://sefin.nfse.gov.br/SefinNacional";

/** Executa apenas na máquina central. Nunca desativa a validação TLS. */
export async function emitirNoPortal(job: Job) {
  const agent = new https.Agent({ key: job.chavePem, cert: job.certPem, keepAlive: false });
  const request = (caminho: string, body?: string) => new Promise<{ ok: boolean; status: number; text: string }>((resolve, reject) => {
    const req = https.request(URL_PORTAL + caminho, { agent, method: body === undefined ? "GET" : "POST", timeout: 60_000,
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }) },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; if (text.length > 3_000_000) req.destroy(new Error("Resposta fiscal muito grande.")); });
      res.on("error", reject);
      res.on("end", () => { const status = res.statusCode ?? 0; resolve({ status, ok: status >= 200 && status < 300, text }); });
    });
    req.on("timeout", () => req.destroy(new Error("Portal não respondeu a tempo; consulte a mesma DPS antes de reenviar.")));
    req.on("error", () => reject(new Error("Conexão fiscal interrompida; tente recuperar a mesma DPS, sem excluí-la.")));
    req.end(body);
  });
  const unzip = async (b64: string) => gunzipSync(Buffer.from(b64, "base64"), { maxOutputLength: 2_000_000 }).toString("utf8");
  const recuperar = () => recuperarNotaProcessada(job.xml, (p) => request(p), unzip, async () => {});
  try {
    // Reserva expirada significa resultado incerto: consulta, nunca reenvia automaticamente.
    if (job.recuperar) return await recuperar();
    const res = await request("/nfse", JSON.stringify({ dpsXmlGZipB64: gzipSync(job.xml).toString("base64") }));
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.text); } catch { throw new Error(`Portal Nacional respondeu HTTP ${res.status} sem retorno fiscal válido. A DPS foi preservada.`); }
    if (dpsJaProcessada(body)) return await recuperar();
    if (!res.ok) {
      const erros = body["erros"] ?? body["Erros"];
      const codigos = Array.isArray(erros) ? erros.map((e) => String(e?.Codigo ?? e?.codigo ?? "").replace(/[^A-Z0-9]/gi, "").slice(0, 20)).join(", ") : "";
      throw new Error(`Portal Nacional respondeu HTTP ${res.status}${codigos ? ` (${codigos})` : ""}. Consulte a DPS antes de tentar novamente.`);
    }
    if (!body["nfseXmlGZipB64"]) return await recuperar();
    const xml = await unzip(String(body["nfseXmlGZipB64"]));
    const idDps = job.xml.match(/<infDPS\b[^>]*\bId="(DPS\d{42})"/)?.[1] ?? "";
    const chaveAcesso = String(body["chaveAcesso"] ?? "");
    const numero = Number(xml.match(/<(?:\w+:)?nNFSe>\s*(\d+)\s*<\/(?:\w+:)?nNFSe>/)?.[1]);
    validarRetornoFiscal(job.xml, xml, chaveAcesso, numero, idDps);
    return { xml, idDps, chaveAcesso, numero };
  } finally {
    agent.destroy();
    job.chavePem = ""; job.certPem = "";
  }
}

type Consulta = { reserva: string; fonte: string; url: string; body: string | null; chavePem: string; certPem: string };
/** Busca de notas emitidas/tomadas (Portal Nacional ou SEFAZ) com o A1 em memória. */
export async function consultarDistribuicao(c: Consulta) {
  const agent = new https.Agent({ key: c.chavePem, cert: c.certPem, keepAlive: false });
  try {
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const body = c.body ?? undefined;
      const req = https.request(c.url, { agent, method: body ? "POST" : "GET", timeout: 60_000,
        headers: body ? { "Content-Type": 'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"', "Content-Length": Buffer.byteLength(body) } : { Accept: "application/json" },
      }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (k) => { text += k; if (text.length > 19_000_000) req.destroy(new Error("Resposta fiscal muito grande.")); });
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.on("timeout", () => req.destroy(new Error("A fonte fiscal não respondeu a tempo.")));
      req.on("error", (e) => reject(e));
      req.end(body);
    });
  } finally { agent.destroy(); c.chavePem = ""; c.certPem = ""; }
}

export async function cicloDistribuicao(api: Api, log: (s: string) => void) {
  const { consulta } = await api("/api/public/agente-local/fiscal/pendentes", { method: "POST" }) as { consulta: Consulta | null };
  if (!consulta) return false;
  const nome = consulta.fonte === "sefaz" ? "SEFAZ" : "NFS-e";
  log(`Busca de notas ${nome}: consultando com o certificado A1…`);
  let retorno: Record<string, unknown>;
  try { retorno = await consultarDistribuicao(consulta); }
  catch (e) { retorno = { status: 0, text: "", erro: `Falha de conexão com ${nome}: ${e instanceof Error ? e.message.slice(0, 300) : "erro"}` }; }
  // Repete somente a entrega, nunca a consulta externa que consome o intervalo.
  let salvo = false;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    try {
      const r = await api("/api/public/agente-local/fiscal/concluir", { method: "POST", body: JSON.stringify({ reserva: consulta.reserva, ...retorno }) });
      if (r?.ok) {
        log(`Busca de notas ${nome}: ${r.msg ?? (retorno["erro"] as string) ?? "concluída"}`);
        salvo = true;
        break;
      }
    } catch { /* entrega novamente a mesma resposta e reserva */ }
    await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
  }
  if (!salvo) log(`Busca de notas ${nome}: retorno não salvo; cursor preservado. Verifique a conexão.`);
  return true;
}

/** Canal independente da busca judicial; um envio por vez, sem sobreposição. */
export function iniciarCanalFiscal(api: Api, configurado: () => boolean, log: (s: string) => void, estado: (s: string) => void) {
  let ocupado = false, falhas = 0;
  let buscando = false, falhasBusca = 0;
  // Uma consulta lenta no ADN/SEFAZ não pode segurar uma emissão de DPS.
  const buscar = async () => {
    if (buscando || !configurado()) return;
    buscando = true;
    try { await cicloDistribuicao(api, log); falhasBusca = 0; }
    catch {
      if (++falhasBusca === 1 || falhasBusca % 20 === 0) log("Busca de notas: falha ao falar com o VÉZIADV; será repetida.");
    } finally { buscando = false; }
  };
  const ciclo = async () => {
    if (ocupado || !configurado()) return;
    ocupado = true;
    try {
      const { nota } = await api("/api/public/agente-local/nfse/pendentes", { method: "POST" }) as { nota: Job | null };
      falhas = 0;
      if (!nota) { estado("Pronto"); return; }
      estado("Transmitindo"); log("NFS-e: DPS reservada; iniciando conexão autenticada ao Portal Nacional.");
      let retorno: Record<string, unknown>;
      try { const r = await emitirNoPortal(nota); retorno = { chave: r.chaveAcesso, protocolo: r.idDps, xml: r.xml, numero: r.numero }; }
      catch (e) { retorno = { erro: e instanceof Error ? e.message.slice(0, 2000) : "Falha fiscal; DPS preservada." }; }
      // Repete somente a gravação do resultado, nunca o POST de emissão.
      let salvo = false;
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        try { const r = await api("/api/public/agente-local/nfse/concluir", { method: "POST", body: JSON.stringify({ id: nota.id, reserva: nota.reserva, ...retorno }) }); if (r.ok) { salvo = true; break; } }
        catch { /* tenta gravar novamente com a mesma reserva */ }
        await new Promise((r) => setTimeout(r, 2000 * (tentativa + 1)));
      }
      estado(salvo ? (retorno["erro"] ? "Falha registrada" : "Autorizada") : "Resultado pendente de recuperação");
      log(salvo ? (retorno["erro"] ? "NFS-e: falha registrada no escritório; DPS preservada." : "NFS-e: autorização salva no escritório.") : "NFS-e: retorno não salvo. A próxima reserva consultará a DPS sem emitir novamente.");
    } catch { if (++falhas === 1 || falhas % 20 === 0) log("Canal fiscal indisponível. Verifique conexão e token central."); estado("Desconectado"); }
    finally { ocupado = false; }
  };
  setInterval(ciclo, 3000);
  setInterval(buscar, 3000);
  // Continua sinalizando presença enquanto o Portal demora a responder.
  setInterval(() => { if (configurado()) void api("/api/public/agente-local/heartbeat", { method: "POST" }).catch(() => {}); }, 10_000);
  void ciclo();
  void buscar();
}