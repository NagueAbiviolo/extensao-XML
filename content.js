/**
 * Content script da extensão XML Form Filler.
 *
 * Escaneia campos de formulário na página e faz matching
 * com dados vindos do XML carregado no popup.
 *
 * Estratégias de matching (em ordem de prioridade):
 *   1. ID exato do campo contém a chave do XML
 *   2. Name exato do campo contém a chave do XML
 *   3. Label associado ao campo contém a chave do XML
 *   4. Placeholder contém a chave do XML
 *   5. Matching por sinônimos/aliases comuns
 */

(() => {
    // ─── Aliases para matching ───
    // Mapeamento de termos comuns em XMLs brasileiros para possíveis ids/names de campos
    const ALIASES = {
        // NF-e
        nNF: ["notafiscal", "nota_fiscal", "nf", "numnotafiscal", "numero_nota", "numeronota", "txtNotaFiscal"],
        nota_fiscal: ["notafiscal", "nf", "numnotafiscal", "numero_nota", "numeronota", "nNF", "txtNotaFiscal"],
        serie: ["serie", "serienf", "serie_nf"],
        dhEmi: ["dataemissao", "data_emissao", "dtemissao", "dt_emissao", "emissao"],
        data_emissao: ["dataemissao", "dtemissao", "dt_emissao", "emissao", "dhEmi"],
        data_emissao_inicio: ["calendarDataInicial", "dataInicial", "data_inicial", "datainicio", "periodoEmissao"],
        data_emissao_fim: ["calendarDataFinal", "dataFinal", "data_final", "datafim", "periodoEmissao"],
        cnpj_emitente: ["cnpj", "cnpjfornecedor", "cnpj_fornecedor", "fornecedor"],
        fornecedor: ["cnpj", "cnpjfornecedor", "cnpj_fornecedor", "cnpj_emitente", "fornecedor"],
        fornecedor_nome: ["nomefornecedor", "nome_fornecedor", "razaosocial", "razao_social", "xNome"],
        xNome_emitente: ["nomefornecedor", "nome_fornecedor", "razaosocial", "razao_social"],
        vNF: ["valornf", "valor_nf", "valortotal", "valor_total", "totalnf", "total_nf"],
        valor_nf: ["valornf", "valortotal", "valor_total", "totalnf", "total_nf", "vNF"],
        vProd: ["valorprodutos", "valor_produtos", "totalprodutos"],
        valor_produtos: ["valorprodutos", "totalprodutos", "vProd"],
        chNFe: ["chaveacesso", "chave_acesso", "chavenfe", "chave_nfe"],
        chave_acesso: ["chaveacesso", "chavenfe", "chave_nfe", "chNFe"],
        empenho: ["empenho", "numempenho", "num_empenho", "ne"],
        documento: ["documento", "doc", "numdocumento", "num_documento", "txtDocumento"],
        processo: ["processo", "numprocesso", "num_processo", "txtProcesso"],
        material: ["material", "codigomaterial", "codigo_material", "codigoMaterial"],
        patrimonio: ["patrimonio", "numpatrimonio"],
        centro_custo: ["centrocusto", "centroCusto", "cc"],
        uorg: ["uorg", "unidade", "uorgEntrada"],
        situacao: ["situacao", "status", "cmbSituacao"],
        tipo_documento: ["tipodocumento", "tipo_doc", "cmbTipo"],
        data_recebimento_inicio: ["dataRecebimentoInicio", "dtRecebInicio", "calendarDataInicial"],
        data_recebimento_fim: ["dataRecebimentoFim", "dtRecebFim", "calendarDataFinal"],
        // Dados pessoais
        nome: ["nome", "name", "fullname", "nomeCompleto", "nome_completo"],
        cpf: ["cpf", "numcpf", "num_cpf", "documento"],
        cnpj: ["cnpj", "numcnpj", "num_cnpj"],
        email: ["email", "e-mail", "correio"],
        telefone: ["telefone", "tel", "phone", "fone", "celular"],
        endereco: ["endereco", "logradouro", "rua", "address", "xLgr"],
        numero: ["numero", "nro", "num", "number"],
        bairro: ["bairro", "xBairro"],
        cidade: ["cidade", "municipio", "xMun", "city"],
        estado: ["estado", "uf", "UF", "state"],
        cep: ["cep", "zipcode", "zip", "codigopostal"],
    };

    /**
     * Normaliza uma string para comparação: lowercase, remove acentos, underscores, hífens.
     */
    function normalize(str) {
        if (!str) return "";
        return str
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[-_\s:.]/g, "")
            .trim();
    }

    /**
     * Retorna o label associado a um campo de formulário.
     */
    function getFieldLabel(field) {
        // 1. Label com for=id
        if (field.id) {
            const label = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
            if (label) return label.textContent.trim();
        }

        // 2. Label pai
        const parentLabel = field.closest("label");
        if (parentLabel) return parentLabel.textContent.trim();

        // 3. aria-label
        if (field.getAttribute("aria-label")) return field.getAttribute("aria-label");

        // 4. Texto anterior no DOM (td ou div irmão)
        const prev = field.previousElementSibling;
        if (prev && (prev.tagName === "LABEL" || prev.tagName === "SPAN")) {
            return prev.textContent.trim();
        }

        // 5. PrimeFaces: procura label no container pai (ui-outputlabel)
        const container = field.closest(".ui-inputfield, .ui-selectonemenu");
        if (container && container.parentElement) {
            const lbl = container.parentElement.querySelector("label, .ui-outputlabel");
            if (lbl) return lbl.textContent.trim();
        }

        return "";
    }

    /**
     * Coleta todos os campos de formulário preenchíveis da página.
     */
    function collectFields() {
        const fields = [];
        const selector = [
            "input[type='text']",
            "input[type='number']",
            "input[type='email']",
            "input[type='tel']",
            "input[type='date']",
            "input[type='datetime-local']",
            "input[type='search']",
            "input[type='url']",
            "input[type='hidden']",
            "input:not([type])",
            "textarea",
            "select",
        ].join(", ");

        document.querySelectorAll(selector).forEach((field) => {
            // Ignora campos de CSRF, tokens, etc.
            const name = (field.name || "").toLowerCase();
            if (/^(csrf|_token|__request|viewstate|javax\.faces)/i.test(name)) return;

            fields.push({
                element: field,
                id: field.id || "",
                name: field.name || "",
                type: field.tagName.toLowerCase() + (field.type ? `[${field.type}]` : ""),
                placeholder: field.placeholder || "",
                label: getFieldLabel(field),
                isSelect: field.tagName.toLowerCase() === "select",
            });
        });

        return fields;
    }

    /**
     * Tenta fazer matching entre uma chave do XML e os campos disponíveis.
     * Retorna o campo mais relevante ou null.
     */
    function findMatchingField(xmlKey, fields) {
        const normKey = normalize(xmlKey);
        const aliases = ALIASES[xmlKey] || [];
        const normAliases = aliases.map(normalize);

        // Todos os termos para buscar (chave original + aliases)
        const searchTerms = [normKey, ...normAliases];

        let bestMatch = null;
        let bestScore = 0;

        for (const field of fields) {
            const normId = normalize(field.id);
            const normName = normalize(field.name);
            const normLabel = normalize(field.label);
            const normPlaceholder = normalize(field.placeholder);

            for (const term of searchTerms) {
                if (!term) continue;

                let score = 0;

                // ID match exato
                if (normId === term) {
                    score = 100;
                }
                // ID contém o termo
                else if (normId && normId.includes(term)) {
                    score = 80;
                }
                // Termo contém o ID (para IDs mais curtos)
                else if (normId && normId.length > 2 && term.includes(normId)) {
                    score = 40;
                }
                // Name match exato
                else if (normName === term) {
                    score = 90;
                }
                // Name contém o termo
                else if (normName && normName.includes(term)) {
                    score = 70;
                }
                // Label match
                else if (normLabel === term) {
                    score = 60;
                }
                else if (normLabel && normLabel.includes(term)) {
                    score = 50;
                }
                // Placeholder match
                else if (normPlaceholder && normPlaceholder.includes(term)) {
                    score = 30;
                }

                // Bônus se o campo não é hidden
                if (score > 0 && field.element.type !== "hidden") {
                    score += 5;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = field;
                }
            }
        }

        return bestScore >= 30 ? bestMatch : null;
    }

    // ─── Utilidades de data ───

    /**
     * Detecta se um campo é de data (por tipo, classe, id, máscara, placeholder, etc.).
     */
    function isDateField(field) {
        const el = field.element;
        const type = (el.type || "").toLowerCase();
        if (type === "date" || type === "datetime-local") return true;

        const id = (field.id || "").toLowerCase();
        const name = (field.name || "").toLowerCase();
        const cls = (el.className || "").toLowerCase();
        const placeholder = (field.placeholder || "").toLowerCase();

        // PrimeFaces calendar
        if (cls.includes("hasDatepicker") || cls.includes("ui-inputfield") && id.includes("calendar")) return true;
        if (el.closest(".ui-calendar, .ui-datepicker-trigger, .p-calendar")) return true;

        // jQuery UI datepicker
        if (cls.includes("hasDatepicker") || el.getAttribute("data-provide") === "datepicker") return true;

        // Heurística por id/name/placeholder
        const dateTerms = /data|date|dt_|periodo|calendar|dtemissao|dtreceb|dhemi|nascimento|vencimento|validade/i;
        if (dateTerms.test(id) || dateTerms.test(name) || dateTerms.test(placeholder)) return true;

        // Máscara dd/mm/yyyy
        if (/dd\/mm\/yyyy|__\/__|\d{2}\/\d{2}\/\d{4}/i.test(placeholder)) return true;
        if (el.getAttribute("data-inputmask") || el.getAttribute("data-mask")) return true;

        return false;
    }

    /**
     * Detecta se uma chave do XML é de data.
     */
    function isDateKey(xmlKey) {
        const k = xmlKey.toLowerCase();
        return /data|date|dt_|dhemi|periodo|emissao|recebimento|nascimento|vencimento|validade/i.test(k);
    }

    /**
     * Tenta extrair uma data de uma string em vários formatos e retorna
     * um objeto { day, month, year } ou null.
     */
    function parseDate(str) {
        if (!str) return null;
        str = str.trim();

        // DD/MM/YYYY ou DD-MM-YYYY
        let m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
        if (m) return { day: m[1].padStart(2, "0"), month: m[2].padStart(2, "0"), year: m[3] };

        // YYYY-MM-DD (ISO) possivelmente com horário
        m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return { day: m[3], month: m[2], year: m[1] };

        // YYYY/MM/DD
        m = str.match(/^(\d{4})\/(\d{2})\/(\d{2})/);
        if (m) return { day: m[3], month: m[2], year: m[1] };

        // DDMMYYYY (sem separador)
        m = str.match(/^(\d{2})(\d{2})(\d{4})$/);
        if (m) return { day: m[1], month: m[2], year: m[3] };

        return null;
    }

    /**
     * Converte uma data para o formato que o campo espera.
     */
    function formatDateForField(field, dateStr) {
        const parsed = parseDate(dateStr);
        if (!parsed) return dateStr; // retorna original se não conseguiu parsear

        const { day, month, year } = parsed;
        const el = field.element;
        const type = (el.type || "").toLowerCase();

        // input[type="date"] precisa de YYYY-MM-DD
        if (type === "date") {
            return `${year}-${month}-${day}`;
        }

        // input[type="datetime-local"] precisa de YYYY-MM-DDT00:00
        if (type === "datetime-local") {
            return `${year}-${month}-${day}T00:00`;
        }

        // Para input text com máscara ou calendário brasileiro, usa DD/MM/YYYY
        return `${day}/${month}/${year}`;
    }

    /**
     * Simula digitação caractere a caractere (necessário para inputs com máscara).
     */
    function typeCharByChar(el, value) {
        el.focus();
        el.value = "";
        el.dispatchEvent(new Event("focus", { bubbles: true }));

        for (let i = 0; i < value.length; i++) {
            const char = value[i];
            el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

            // Insere o caractere, atualizando o value incrementalmente
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
            )?.set;
            const newVal = el.value + char;
            if (nativeSetter) {
                nativeSetter.call(el, newVal);
            } else {
                el.value = newVal;
            }

            el.dispatchEvent(new InputEvent("input", { data: char, inputType: "insertText", bubbles: true }));
            el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        }
    }

    /**
     * Preenche um campo de data com tratamento especial.
     */
    function fillDateField(field, value) {
        const el = field.element;
        const formattedValue = formatDateForField(field, value);
        const type = (el.type || "").toLowerCase();

        const wasReadonly = el.readOnly;
        const wasDisabled = el.disabled;
        el.readOnly = false;
        el.disabled = false;

        // 1. input[type="date"] / input[type="datetime-local"] — usa valueAsDate ou value direto
        if (type === "date" || type === "datetime-local") {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
            )?.set;
            if (nativeSetter) {
                nativeSetter.call(el, formattedValue);
            } else {
                el.value = formattedValue;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            if (wasReadonly) el.readOnly = true;
            if (wasDisabled) el.disabled = true;
            highlightElement(el);
            return true;
        }

        // 2. PrimeFaces Calendar — tenta via widget
        try {
            const widgetId = el.id.replace(/_input$/, "");
            if (typeof PrimeFaces !== "undefined") {
                const widget = PrimeFaces.getWidgetById(widgetId);
                if (widget && widget.setDate) {
                    const parsed = parseDate(value);
                    if (parsed) {
                        const dateObj = new Date(parsed.year, parseInt(parsed.month) - 1, parseInt(parsed.day));
                        widget.setDate(dateObj);
                        if (wasReadonly) el.readOnly = true;
                        if (wasDisabled) el.disabled = true;
                        highlightElement(el);
                        return true;
                    }
                }
            }
        } catch (_) { }

        // 3. jQuery UI Datepicker
        try {
            if (typeof jQuery !== "undefined" && jQuery(el).datepicker) {
                jQuery(el).datepicker("setDate", formattedValue);
                if (wasReadonly) el.readOnly = true;
                if (wasDisabled) el.disabled = true;
                highlightElement(el);
                return true;
            }
        } catch (_) { }

        // 4. Masked input – simula digitação (apenas os dígitos da data)
        const hasMask = el.getAttribute("data-inputmask") ||
            el.getAttribute("data-mask") ||
            (el.className || "").includes("mask") ||
            (el.className || "").includes("hasDatepicker");

        if (hasMask) {
            const digits = formattedValue.replace(/\D/g, ""); // ex: "16122025"
            typeCharByChar(el, digits);
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
            if (wasReadonly) el.readOnly = true;
            if (wasDisabled) el.disabled = true;
            highlightElement(el);
            return true;
        }

        // 5. Fallback: tenta digitar o valor formatado caractere a caractere
        //    (funciona melhor com máscaras não detectadas e campos PrimeFaces)
        typeCharByChar(el, formattedValue);
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));

        // Se ainda vazio, tenta via nativeInputValueSetter como último recurso
        if (!el.value || el.value.replace(/[_\/\-]/g, "").trim() === "") {
            const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, "value"
            )?.set;
            if (nativeSetter) {
                nativeSetter.call(el, formattedValue);
            } else {
                el.value = formattedValue;
            }
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            el.dispatchEvent(new Event("blur", { bubbles: true }));
        }

        if (wasReadonly) el.readOnly = true;
        if (wasDisabled) el.disabled = true;
        highlightElement(el);
        return true;
    }

    /**
     * Preenche um campo com um valor.
     */
    function fillField(field, value, xmlKey) {
        const el = field.element;

        if (field.isSelect) {
            return fillSelect(el, value);
        }

        // Detecta se é campo de data (pelo campo OU pela chave do XML)
        if (isDateField(field) || isDateKey(xmlKey || "")) {
            return fillDateField(field, value);
        }

        // Campo de texto/input normal
        const wasReadonly = el.readOnly;
        const wasDisabled = el.disabled;
        el.readOnly = false;
        el.disabled = false;

        // Usa nativeInputValueSetter para frameworks como React
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        )?.set;
        const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
        )?.set;

        if (el.tagName === "TEXTAREA" && nativeTextareaValueSetter) {
            nativeTextareaValueSetter.call(el, value);
        } else if (nativeInputValueSetter) {
            nativeInputValueSetter.call(el, value);
        } else {
            el.value = value;
        }

        // Dispara eventos para frameworks reativos
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

        // Restaura estado
        if (wasReadonly) el.readOnly = true;
        if (wasDisabled) el.disabled = true;

        // Highlight visual temporário
        highlightElement(el);

        return true;
    }

    /**
     * Preenche um select tentando casar o valor por value ou texto.
     */
    function fillSelect(selectEl, value) {
        const normValue = normalize(value);

        // Tenta por value exato
        for (const option of selectEl.options) {
            if (option.value === value) {
                selectEl.value = option.value;
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                highlightElement(selectEl);
                return true;
            }
        }

        // Tenta por texto normalizado
        for (const option of selectEl.options) {
            if (normalize(option.text) === normValue || normalize(option.value) === normValue) {
                selectEl.value = option.value;
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                highlightElement(selectEl);
                return true;
            }
        }

        // Tenta match parcial
        for (const option of selectEl.options) {
            if (normalize(option.text).includes(normValue) || normValue.includes(normalize(option.text))) {
                selectEl.value = option.value;
                selectEl.dispatchEvent(new Event("change", { bubbles: true }));
                highlightElement(selectEl);
                return true;
            }
        }

        // PrimeFaces: tenta widget
        try {
            const containerId = selectEl.id.replace("_input", "");
            if (typeof PrimeFaces !== "undefined") {
                const widget = PrimeFaces.getWidgetById(containerId);
                if (widget) {
                    widget.selectValue(value);
                    return true;
                }
            }
        } catch (_) { }

        return false;
    }

    function highlightElement(el) {
        const origBg = el.style.backgroundColor;
        const origOutline = el.style.outline;
        el.style.backgroundColor = "#d5f5e3";
        el.style.outline = "2px solid #27ae60";
        setTimeout(() => {
            el.style.backgroundColor = origBg;
            el.style.outline = origOutline;
        }, 2000);
    }

    // ─── Message listener ───

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.action === "fillForm") {
            const data = message.data;
            const fields = collectFields();
            const results = [];

            for (const [xmlKey, xmlValue] of Object.entries(data)) {
                // Ignora campos com valores vazios ou objetos complexos
                if (!xmlValue || typeof xmlValue === "object") continue;

                const matchedField = findMatchingField(xmlKey, fields);
                if (matchedField) {
                    const filled = fillField(matchedField, xmlValue, xmlKey);
                    results.push({
                        xmlKey,
                        value: xmlValue,
                        matched: filled,
                        fieldId: matchedField.id,
                        fieldName: matchedField.name,
                        fieldLabel: matchedField.label,
                    });
                    // Remove campo usado para não preencher duas vezes o mesmo campo
                    const idx = fields.indexOf(matchedField);
                    if (idx > -1) fields.splice(idx, 1);
                } else {
                    results.push({
                        xmlKey,
                        value: xmlValue,
                        matched: false,
                    });
                }
            }

            sendResponse({ results });
            return true;
        }

        if (message.action === "scanFields") {
            const fields = collectFields();
            sendResponse({
                fields: fields.map((f) => ({
                    id: f.id,
                    name: f.name,
                    type: f.type,
                    label: f.label,
                    placeholder: f.placeholder,
                })),
            });
            return true;
        }
    });
})();
