/** Valida o vínculo fiscal antes de aceitar a autorização do coletor. */
export function validarRetornoFiscal(xmlDps: string, xml: string, chave: string, numero: number, protocolo: string) {
  const id = xmlDps.match(/<infDPS\b[^>]*\bId="(DPS\d{42})"/)?.[1];
  const oficial = xml.match(/<(?:\w+:)?infDPS\b[^>]*\bId="([^"]+)"/)?.[1];
  const chaveXml = xml.match(/<(?:\w+:)?infNFSe\b[^>]*\bId="NFS(\d{50})"/)?.[1];
  const numeroXml = Number(xml.match(/<(?:\w+:)?nNFSe>\s*(\d+)\s*<\/(?:\w+:)?nNFSe>/)?.[1]);
  if (!id || oficial !== id || protocolo !== id || !/^\d{50}$/.test(chave) || chaveXml !== chave || numeroXml !== numero || !Number.isSafeInteger(numero) || numero < 1) {
    throw new Error("O retorno não corresponde à DPS reservada. A nota não foi alterada.");
  }
}
export const notaEmTransmissao = (status: string) => status === "pendente_transmissao";

export function podeColetarOrganizacao(central: boolean, orgAgente: string, orgRegistro: string) {
  return central || orgAgente === orgRegistro;
}