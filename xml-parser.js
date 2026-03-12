/**
 * XML Parser para a extensão XML Form Filler.
 * Converte XML (genérico ou NF-e) em um mapa plano de chave-valor.
 */

const XmlParser = (() => {

    /**
     * Faz o parse de uma string XML e retorna um objeto flat { chave: valor }.
     * Suporta XML genérico e NF-e.
     */
    function parse(xmlString) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlString, "text/xml");

        const parseError = doc.querySelector("parsererror");
        if (parseError) {
            throw new Error("XML inválido: " + parseError.textContent.substring(0, 100));
        }

        // Detecta se é NF-e
        const isNfe = isNfeXml(doc);
        if (isNfe) {
            return parseNfe(doc);
        }

        // XML genérico: extrai todos os elementos folha
        return parseGeneric(doc.documentElement);
    }

    /**
     * Detecta se o XML é uma NF-e (Nota Fiscal Eletrônica).
     */
    function isNfeXml(doc) {
        const root = doc.documentElement;
        const tagName = root.localName || root.tagName;
        // NF-e pode ter raiz nfeProc, NFe, etc.
        if (/^(nfeProc|NFe|enviNFe)$/i.test(tagName)) return true;
        // Verifica namespace
        if (root.namespaceURI && root.namespaceURI.includes("portalfiscal.inf.br/nfe")) return true;
        // Verifica se contém elementos típicos
        if (doc.getElementsByTagNameNS("http://www.portalfiscal.inf.br/nfe", "infNFe").length > 0) return true;
        return false;
    }

    /**
     * Parse específico para NF-e, extrai campos relevantes com nomes amigáveis.
     */
    function parseNfe(doc) {
        const ns = "http://www.portalfiscal.inf.br/nfe";
        const dados = {};

        const getEl = (parent, tag) => {
            const els = parent ? parent.getElementsByTagNameNS(ns, tag) : doc.getElementsByTagNameNS(ns, tag);
            return els.length > 0 ? els[0] : null;
        };

        const getText = (parent, tag) => {
            const el = getEl(parent, tag);
            return el ? el.textContent.trim() : null;
        };

        const infNFe = getEl(null, "infNFe");
        const ide = getEl(infNFe, "ide");
        const emit = getEl(infNFe, "emit");
        const dest = getEl(infNFe, "dest");
        const total = getEl(infNFe, "total");
        const icmsTot = getEl(total, "ICMSTot");

        // Identificação
        if (ide) {
            addIfPresent(dados, "nNF", getText(ide, "nNF"));
            addIfPresent(dados, "nota_fiscal", getText(ide, "nNF"));
            addIfPresent(dados, "serie", getText(ide, "serie"));
            addIfPresent(dados, "natOp", getText(ide, "natOp"));
            addIfPresent(dados, "natureza_operacao", getText(ide, "natOp"));
            const dhEmi = getText(ide, "dhEmi");
            if (dhEmi) {
                const dataPart = dhEmi.substring(0, 10); // 2025-12-16
                const partes = dataPart.split("-");
                if (partes.length === 3) {
                    const dataFmt = `${partes[2]}/${partes[1]}/${partes[0]}`;
                    dados["data_emissao"] = dataFmt;
                    dados["data_emissao_inicio"] = dataFmt;
                    dados["data_emissao_fim"] = dataFmt;
                    dados["dhEmi"] = dataFmt;
                }
            }
        }

        // Emitente
        if (emit) {
            addIfPresent(dados, "cnpj_emitente", getText(emit, "CNPJ"));
            addIfPresent(dados, "fornecedor", getText(emit, "CNPJ"));
            addIfPresent(dados, "xNome_emitente", getText(emit, "xNome"));
            addIfPresent(dados, "fornecedor_nome", getText(emit, "xNome"));
            addIfPresent(dados, "ie_emitente", getText(emit, "IE"));

            const enderEmit = getEl(emit, "enderEmit");
            if (enderEmit) {
                addIfPresent(dados, "xLgr_emitente", getText(enderEmit, "xLgr"));
                addIfPresent(dados, "nro_emitente", getText(enderEmit, "nro"));
                addIfPresent(dados, "xBairro_emitente", getText(enderEmit, "xBairro"));
                addIfPresent(dados, "xMun_emitente", getText(enderEmit, "xMun"));
                addIfPresent(dados, "UF_emitente", getText(enderEmit, "UF"));
                addIfPresent(dados, "CEP_emitente", getText(enderEmit, "CEP"));
            }
        }

        // Destinatário
        if (dest) {
            addIfPresent(dados, "cnpj_destinatario", getText(dest, "CNPJ"));
            addIfPresent(dados, "cpf_destinatario", getText(dest, "CPF"));
            addIfPresent(dados, "xNome_destinatario", getText(dest, "xNome"));
        }

        // Totais
        if (icmsTot) {
            addIfPresent(dados, "vNF", getText(icmsTot, "vNF"));
            addIfPresent(dados, "valor_nf", getText(icmsTot, "vNF"));
            addIfPresent(dados, "vProd", getText(icmsTot, "vProd"));
            addIfPresent(dados, "valor_produtos", getText(icmsTot, "vProd"));
            addIfPresent(dados, "vFrete", getText(icmsTot, "vFrete"));
            addIfPresent(dados, "vDesc", getText(icmsTot, "vDesc"));
            addIfPresent(dados, "vICMS", getText(icmsTot, "vICMS"));
            addIfPresent(dados, "vIPI", getText(icmsTot, "vIPI"));
            addIfPresent(dados, "vPIS", getText(icmsTot, "vPIS"));
            addIfPresent(dados, "vCOFINS", getText(icmsTot, "vCOFINS"));
        }

        // Chave de acesso
        const protNFe = getEl(null, "protNFe");
        if (protNFe) {
            addIfPresent(dados, "chNFe", getText(protNFe, "chNFe"));
            addIfPresent(dados, "chave_acesso", getText(protNFe, "chNFe"));
            addIfPresent(dados, "nProt", getText(protNFe, "nProt"));
        }

        // Info complementar
        const infAdic = getEl(infNFe, "infAdic");
        if (infAdic) {
            addIfPresent(dados, "infCpl", getText(infAdic, "infCpl"));
        }

        // Itens (det) — cada item vira um grupo selecionável
        const groups = [];
        const dets = infNFe ? infNFe.getElementsByTagNameNS(ns, "det") : [];
        for (let i = 0; i < dets.length; i++) {
            const det = dets[i];
            const nItem = det.getAttribute("nItem") || String(i + 1);
            const prod = getEl(det, "prod");
            const gf = {};
            if (prod) {
                addIfPresent(gf, "xProd", getText(prod, "xProd"));
                addIfPresent(gf, "descricao_produto", getText(prod, "xProd"));
                addIfPresent(gf, "cProd", getText(prod, "cProd"));
                addIfPresent(gf, "codigo_produto", getText(prod, "cProd"));
                addIfPresent(gf, "NCM", getText(prod, "NCM"));
                addIfPresent(gf, "CFOP", getText(prod, "CFOP"));
                addIfPresent(gf, "uCom", getText(prod, "uCom"));
                addIfPresent(gf, "unidade", getText(prod, "uCom"));
                addIfPresent(gf, "qCom", getText(prod, "qCom"));
                addIfPresent(gf, "quantidade", getText(prod, "qCom"));
                addIfPresent(gf, "vUnCom", getText(prod, "vUnCom"));
                addIfPresent(gf, "valor_unitario", getText(prod, "vUnCom"));
                addIfPresent(gf, "vProd_item", getText(prod, "vProd"));
                addIfPresent(gf, "valor_produto", getText(prod, "vProd"));
                addIfPresent(gf, "cEAN", getText(prod, "cEAN"));
                addIfPresent(gf, "vDesc_item", getText(prod, "vDesc"));
                addIfPresent(gf, "vFrete_item", getText(prod, "vFrete"));
            }

            const xProd = gf.xProd || "";
            const label = `Item ${nItem}` + (xProd ? ` — ${xProd}` : "");
            if (Object.keys(gf).length > 0) {
                groups.push({ label, fields: gf });
            }
        }

        return { fields: dados, groups };
    }

    /**
     * Parse genérico com detecção de grupos.
     * Elementos repetidos com sub-elementos viram grupos selecionáveis.
     */
    function parseGeneric(rootElement) {
        const result = extractGroupsAtLevel(rootElement);

        // Se não achou grupos na raiz, tenta um nível abaixo
        if (result.groups.length === 0) {
            for (const child of rootElement.children) {
                if (child.children.length > 1) {
                    const deeper = extractGroupsAtLevel(child);
                    if (deeper.groups.length > 0) {
                        const baseFields = {};
                        for (const sibling of rootElement.children) {
                            if (sibling !== child) {
                                const sibData = flattenElement(sibling);
                                for (const [k, v] of Object.entries(sibData)) {
                                    if (!(k in baseFields)) baseFields[k] = v;
                                }
                            }
                        }
                        for (const [k, v] of Object.entries(deeper.fields)) {
                            if (!(k in baseFields)) baseFields[k] = v;
                        }
                        return { fields: baseFields, groups: deeper.groups };
                    }
                }
            }
        }

        return result;
    }

    /**
     * Extrai grupos de elementos repetidos em um nível específico.
     */
    function extractGroupsAtLevel(element) {
        const children = element.children;

        if (children.length === 0) {
            const text = (element.textContent || "").trim();
            const fields = {};
            if (text) fields[element.localName || element.tagName] = text;
            return { fields, groups: [] };
        }

        const tagCounts = {};
        for (const child of children) {
            const tag = child.localName || child.tagName;
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }

        const fields = {};
        const groups = [];
        const tagIndex = {};

        for (const child of children) {
            const tag = child.localName || child.tagName;

            if (tagCounts[tag] > 1 && child.children.length > 0) {
                tagIndex[tag] = (tagIndex[tag] || 0) + 1;
                const groupFields = flattenElement(child);
                const firstVal = Object.values(groupFields)[0] || "";
                const label = `${tag} ${tagIndex[tag]}` +
                    (firstVal ? ` — ${firstVal.substring(0, 50)}` : "");
                if (Object.keys(groupFields).length > 0) {
                    groups.push({ label, fields: groupFields });
                }
            } else {
                const childData = flattenElement(child);
                for (const [k, v] of Object.entries(childData)) {
                    if (!(k in fields)) fields[k] = v;
                }
            }
        }

        return { fields, groups };
    }

    /**
     * Extrai todos os elementos folha em um mapa plano {chave: valor}.
     */
    function flattenElement(element, prefix) {
        const dados = {};
        const children = element.children;

        if (children.length === 0) {
            const text = (element.textContent || "").trim();
            if (text) {
                const key = prefix || element.localName || element.tagName;
                dados[key] = text;
            }
            return dados;
        }

        const tagCounts = {};
        for (const child of children) {
            const tag = child.localName || child.tagName;
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }

        const tagIndex = {};
        for (const child of children) {
            const tag = child.localName || child.tagName;
            let childKey = tag;
            if (tagCounts[tag] > 1) {
                tagIndex[tag] = (tagIndex[tag] || 0) + 1;
                childKey = `${tag}_${tagIndex[tag]}`;
            }

            const childData = flattenElement(child, childKey);
            for (const [k, v] of Object.entries(childData)) {
                if (!(k in dados)) {
                    dados[k] = v;
                }
            }
        }

        return dados;
    }

    function addIfPresent(obj, key, value) {
        if (value !== null && value !== undefined && value !== "" && !(key in obj)) {
            obj[key] = value;
        }
    }

    return { parse };
})();
