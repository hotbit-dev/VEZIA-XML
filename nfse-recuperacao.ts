type RespostaPortal = { status: number; ok: boolean; text: string };
export type ConsultaPortal = (caminho: string) => Promise<RespostaPortal>;
export type NotaRecuperada = { chaveAcesso: string; idDps: string; xml: string; numero: number };

export function dpsJaProcessada(body: Record<string, unknown>): boolean {
  const erros = body["erros"] ?? body["Erros"];
  return Array.isArray(erros) && erros.some((erro: unknown) => {
    if (!erro || typeof erro !== "object") return false;
    const item = erro as Record<string, unknown>;
    return (item["Codigo"] ?? item["codigo"]) === "E0014";
  });
}

function lerResposta(res: RespostaPortal): Record<string, unknown> {
  if (!res.ok) throw new Error(`Consulta ao Portal Nacional indisponível (HTTP ${res.status}). Tente transmitir novamente mais tarde; não exclua a DPS.`);
  try {
    const body: unknown = JSON.parse(res.text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* resposta inválida */ }
  throw new Error("O Portal Nacional não retornou os dados da nota. Tente novamente mais tarde; não exclua a DPS.");
}

/** Só confirma recuperação após consultar o XML oficial e gravar a mesma nota. */
export async function recuperarNotaProcessada(
  xmlDps: string,
  consultar: ConsultaPortal,
  descompactar: (base64: string) => Promise<string>,
  gravar: (nota: NotaRecuperada) => Promise<void>,
): Promise<NotaRecuperada> {
  const idDps = xmlDps.match(/<infDPS\b[^>]*\bId="(DPS\d{42})"/)?.[1];
  if (!idDps) throw new Error("Não foi possível identificar a DPS para consulta.");
  const dps = lerResposta(await consultar(`/dps/${encodeURIComponent(idDps)}`));
  const chaveAcesso = dps["chaveAcesso"];
  if (typeof chaveAcesso !== "string" || !/^\d{50}$/.test(chaveAcesso)) {
    throw new Error("A DPS consta processada, mas o Portal ainda não retornou sua chave de acesso. Tente novamente mais tarde; não exclua a DPS.");
  }
  const nfse = lerResposta(await consultar(`/nfse/${chaveAcesso}`));
  const comprimido = nfse["nfseXmlGZipB64"];
  if (typeof comprimido !== "string" || !comprimido) throw new Error("O Portal não retornou o XML autorizado. Tente novamente mais tarde; não exclua a DPS.");
  const xml = await descompactar(comprimido);
  const idOficial = xml.match(/<(?:\w+:)?infDPS\b[^>]*\bId="([^"]+)"/)?.[1];
  const chaveOficial = xml.match(/<(?:\w+:)?infNFSe\b[^>]*\bId="NFS(\d{50})"/)?.[1];
  const numero = Number(xml.match(/<(?:\w+:)?nNFSe>\s*(\d+)\s*<\/(?:\w+:)?nNFSe>/)?.[1]);
  if (idOficial !== idDps || chaveOficial !== chaveAcesso || !Number.isSafeInteger(numero) || numero < 1) {
    throw new Error("O XML retornado não corresponde à DPS consultada. A nota não foi alterada.");
  }
  const nota = { chaveAcesso, idDps, xml, numero };
  await gravar(nota);
  return nota;
}