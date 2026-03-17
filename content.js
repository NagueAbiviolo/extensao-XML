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
    // ─── Estado do modo de gravacao ───
    let recordingState = null;

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
        const seen = new Set();
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

            // Se este select esta dentro de um PrimeFaces SelectOneMenu, pula —
            // sera coletado como picker abaixo
            if (field.tagName === "SELECT" && field.closest(".ui-selectonemenu")) {
                seen.add(field);
                const container = field.closest(".ui-selectonemenu");
                fields.push({
                    element: field,
                    container: container,
                    id: field.id || container.id || "",
                    name: field.name || "",
                    type: "picker[selectonemenu]",
                    placeholder: "",
                    label: getPickerLabel(container),
                    isSelect: false,
                    isPicker: true,
                    pickerType: "selectonemenu",
                });
                return;
            }

            fields.push({
                element: field,
                id: field.id || "",
                name: field.name || "",
                type: field.tagName.toLowerCase() + (field.type ? `[${field.type}]` : ""),
                placeholder: field.placeholder || "",
                label: getFieldLabel(field),
                isSelect: field.tagName.toLowerCase() === "select",
                isPicker: false,
            });
        });

        // Coleta PrimeFaces SelectOneMenu que nao tenham <select> interno detectado
        document.querySelectorAll(".ui-selectonemenu").forEach((container) => {
            const innerSelect = container.querySelector("select");
            if (innerSelect && seen.has(innerSelect)) return;

            const id = (innerSelect && innerSelect.id) || container.id || "";
            const name = (innerSelect && innerSelect.name) || "";
            if (/^(csrf|_token|__request|viewstate|javax\.faces)/i.test(name)) return;

            fields.push({
                element: innerSelect || container,
                container: container,
                id: id,
                name: name,
                type: "picker[selectonemenu]",
                placeholder: "",
                label: getPickerLabel(container),
                isSelect: false,
                isPicker: true,
                pickerType: "selectonemenu",
            });
        });

        // Coleta PrimeFaces AutoComplete
        document.querySelectorAll(".ui-autocomplete").forEach((container) => {
            const input = container.querySelector("input.ui-autocomplete-input, input[type='text']");
            if (!input || seen.has(input)) return;
            seen.add(input);

            fields.push({
                element: input,
                container: container,
                id: input.id || container.id || "",
                name: input.name || "",
                type: "picker[autocomplete]",
                placeholder: input.placeholder || "",
                label: getPickerLabel(container),
                isSelect: false,
                isPicker: true,
                pickerType: "autocomplete",
            });
        });

        return fields;
    }

    /**
     * Retorna o label associado a um container de picker PrimeFaces.
     */
    function getPickerLabel(container) {
        // 1. Label com for= apontando para algum elemento interno
        const innerEl = container.querySelector("select, input");
        if (innerEl && innerEl.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(innerEl.id)}"]`);
            if (lbl) return lbl.textContent.trim();
        }

        // 2. Label com for= apontando para o container
        if (container.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(container.id)}"]`);
            if (lbl) return lbl.textContent.trim();
            // PrimeFaces usa sufixos _label, _input no id
            const baseId = container.id.replace(/_input$/, "");
            const lbl2 = document.querySelector(`label[for="${CSS.escape(baseId)}"]`);
            if (lbl2) return lbl2.textContent.trim();
        }

        // 3. Label no container pai
        const parent = container.parentElement;
        if (parent) {
            const lbl = parent.querySelector("label, .ui-outputlabel");
            if (lbl && !container.contains(lbl)) return lbl.textContent.trim();
        }

        // 4. Irmao anterior
        const prev = container.previousElementSibling;
        if (prev && (prev.tagName === "LABEL" || prev.classList.contains("ui-outputlabel"))) {
            return prev.textContent.trim();
        }

        return "";
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

        // Pickers customizados (PrimeFaces SelectOneMenu, AutoComplete, etc.)
        if (field.isPicker) {
            if (field.pickerType === "autocomplete") {
                return fillAutoComplete(field, value);
            }
            return fillPicker(field, value);
        }

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

        return false;
    }

    /**
     * Preenche um PrimeFaces SelectOneMenu (picker customizado).
     * Estrategia: widget API > simular clique no painel overlay.
     */
    function fillPicker(field, value) {
        const container = field.container;
        const selectEl = field.element.tagName === "SELECT" ? field.element : container.querySelector("select");
        const normValue = normalize(value);

        // 1. Tenta via PrimeFaces widget API
        try {
            if (typeof PrimeFaces !== "undefined") {
                const widgetId = (container.id || "").replace(/_input$/, "");
                const widget = PrimeFaces.getWidgetById(widgetId) ||
                    (selectEl && PrimeFaces.getWidgetById(selectEl.id.replace(/_input$/, "")));
                if (widget) {
                    // Busca a option correta no select escondido
                    if (selectEl) {
                        for (const option of selectEl.options) {
                            const normText = normalize(option.text);
                            const normOptVal = normalize(option.value);
                            if (normText === normValue || normOptVal === normValue ||
                                normText.includes(normValue) || normValue.includes(normText)) {
                                widget.selectValue(option.value);
                                highlightElement(container);
                                return true;
                            }
                        }
                    }
                    // Fallback: tenta selectValue direto
                    widget.selectValue(value);
                    highlightElement(container);
                    return true;
                }
            }
        } catch (_) { }

        // 2. Fallback: simula clique para abrir o painel e selecionar o item
        try {
            // Clica no trigger para abrir o dropdown
            const trigger = container.querySelector(".ui-selectonemenu-trigger") ||
                container.querySelector(".ui-selectonemenu-label");
            if (trigger) {
                trigger.click();

                // Espera o painel abrir e busca o item correto
                setTimeout(() => {
                    // O painel pode ser um irmao do container ou estar no body
                    const panelId = container.id + "_panel";
                    let panel = document.getElementById(panelId);
                    if (!panel) {
                        // Busca paineis abertos
                        panel = document.querySelector(".ui-selectonemenu-panel:not([style*='display: none'])") ||
                            document.querySelector(".ui-selectonemenu-items-wrapper:not([style*='display: none'])");
                    }

                    if (panel) {
                        const items = panel.querySelectorAll(".ui-selectonemenu-item, li");
                        let bestItem = null;
                        let bestScore = 0;

                        items.forEach((item) => {
                            const itemText = normalize(item.textContent);
                            let score = 0;
                            if (itemText === normValue) score = 100;
                            else if (itemText.includes(normValue)) score = 70;
                            else if (normValue.includes(itemText) && itemText.length > 2) score = 50;

                            if (score > bestScore) {
                                bestScore = score;
                                bestItem = item;
                            }
                        });

                        if (bestItem) {
                            bestItem.click();
                            highlightElement(container);
                        } else {
                            // Fecha o painel se nao encontrou
                            trigger.click();
                        }
                    }
                }, 150);

                return true;
            }
        } catch (_) { }

        // 3. Ultimo fallback: tenta preencher o select escondido diretamente
        if (selectEl && selectEl.tagName === "SELECT") {
            return fillSelect(selectEl, value);
        }

        return false;
    }

    /**
     * Preenche um PrimeFaces AutoComplete.
     * Digita o valor no input e tenta selecionar a primeira sugestao.
     */
    function fillAutoComplete(field, value) {
        const input = field.element;
        const container = field.container;

        // 1. Tenta via PrimeFaces widget API
        try {
            if (typeof PrimeFaces !== "undefined") {
                const widgetId = (container.id || input.id || "").replace(/_input$/, "");
                const widget = PrimeFaces.getWidgetById(widgetId);
                if (widget && widget.search) {
                    // Limpa e digita o valor
                    input.value = "";
                    const nativeSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, "value"
                    )?.set;
                    if (nativeSetter) {
                        nativeSetter.call(input, value);
                    } else {
                        input.value = value;
                    }
                    input.dispatchEvent(new Event("input", { bubbles: true }));

                    // Dispara a busca do autocomplete
                    widget.search(value);

                    // Espera as sugestoes e seleciona a primeira
                    setTimeout(() => {
                        const panel = document.querySelector(".ui-autocomplete-panel:not([style*='display: none'])");
                        if (panel) {
                            const firstItem = panel.querySelector(".ui-autocomplete-item, li");
                            if (firstItem) {
                                firstItem.click();
                                highlightElement(input);
                                return;
                            }
                        }
                        // Se nao abriu sugestoes, ao menos o valor ficou digitado
                        input.dispatchEvent(new Event("change", { bubbles: true }));
                        input.dispatchEvent(new Event("blur", { bubbles: true }));
                        highlightElement(input);
                    }, 800);

                    return true;
                }
            }
        } catch (_) { }

        // 2. Fallback: simula digitacao e espera sugestoes
        input.focus();
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
        )?.set;
        if (nativeSetter) {
            nativeSetter.call(input, value);
        } else {
            input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) }));

        setTimeout(() => {
            const panel = document.querySelector(".ui-autocomplete-panel:not([style*='display: none'])");
            if (panel) {
                const firstItem = panel.querySelector(".ui-autocomplete-item, li");
                if (firstItem) {
                    firstItem.click();
                    highlightElement(input);
                    return;
                }
            }
            input.dispatchEvent(new Event("blur", { bubbles: true }));
            highlightElement(input);
        }, 800);

        return true;
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

    // ─── Deteccao automatica de botoes ───

    const SAVE_TERMS = ["salvar", "gravar", "save", "confirmar", "enviar", "registrar"];
    const NEW_TERMS = ["novo", "new", "adicionar", "incluir"];

    /**
     * Verifica se um elemento esta visivel na pagina.
     */
    function isVisible(el) {
        if (!el) return false;
        // Verifica display/visibility via computed style (mais confiavel que offsetParent)
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        // Elementos com tamanho 0
        if (el.offsetWidth === 0 && el.offsetHeight === 0 && style.position !== "fixed" && style.position !== "absolute") return false;
        return true;
    }

    /**
     * Extrai o texto significativo de um botao, tentando varias fontes.
     */
    function getButtonText(el) {
        const texts = [];

        // 1. Para inputs: value
        if (el.tagName === "INPUT") {
            if (el.value) texts.push(el.value.trim());
        } else {
            // 2. Texto direto do elemento (sem descer em filhos profundos)
            // Tenta primeiro spans internos (PrimeFaces usa <span class="ui-button-text">)
            const btnTextSpan = el.querySelector(".ui-button-text, .p-button-label, .p-button-text, .btn-text");
            if (btnTextSpan) {
                texts.push(btnTextSpan.textContent.trim());
            }

            // 3. Texto direto dos nos filhos de texto (nao recursivo em sub-elementos complexos)
            const directText = Array.from(el.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE)
                .map(n => n.textContent.trim())
                .filter(t => t)
                .join(" ");
            if (directText) texts.push(directText);

            // 4. textContent completo como fallback
            if (el.textContent) texts.push(el.textContent.trim());
        }

        // 5. Atributos descritivos
        if (el.title) texts.push(el.title.trim());
        if (el.getAttribute("aria-label")) texts.push(el.getAttribute("aria-label").trim());
        if (el.getAttribute("data-original-title")) texts.push(el.getAttribute("data-original-title").trim());
        if (el.getAttribute("data-tooltip")) texts.push(el.getAttribute("data-tooltip").trim());

        // Remove duplicatas e vazios
        const seen = new Set();
        return texts.filter(t => {
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
        });
    }

    /**
     * Gera um seletor CSS unico para um elemento.
     */
    function getButtonIdentifier(el) {
        // 1. ID
        if (el.id) return `#${CSS.escape(el.id)}`;

        // 2. name
        if (el.name) {
            const tag = el.tagName.toLowerCase();
            return `${tag}[name="${CSS.escape(el.name)}"]`;
        }

        // 3. Classes significativas (ignora classes de estado do PrimeFaces/Bootstrap)
        if (el.className && typeof el.className === "string") {
            const ignorePattern = /^(ui-state|ui-corner|p-highlight|p-focus|active|hover|focus|disabled|show|fade|in|out|collapse)/;
            const classes = el.className.trim().split(/\s+/).filter(c => c && !ignorePattern.test(c));
            if (classes.length > 0) {
                const selector = el.tagName.toLowerCase() + "." + classes.map(CSS.escape).join(".");
                // Verifica se e unico
                try {
                    if (document.querySelectorAll(selector).length === 1) return selector;
                } catch (_) { }
                // Tenta com menos classes (mais especificas primeiro)
                for (const cls of classes) {
                    const s = el.tagName.toLowerCase() + "." + CSS.escape(cls);
                    try {
                        if (document.querySelectorAll(s).length === 1) return s;
                    } catch (_) { }
                }
                return el.tagName.toLowerCase() + "." + classes.map(CSS.escape).join(".");
            }
        }

        // 4. Fallback usando value ou posicao
        if (el.tagName === "INPUT" && el.value) {
            return `input[value="${CSS.escape(el.value)}"]`;
        }

        // 5. Nth-child como ultimo recurso
        if (el.parentElement) {
            const siblings = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
            const idx = siblings.indexOf(el) + 1;
            const parentId = el.parentElement.id ? `#${CSS.escape(el.parentElement.id)} > ` : "";
            return `${parentId}${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
        }

        return null;
    }

    /**
     * Coleta todos os elementos clicaveis que possam ser botoes na pagina.
     */
    function collectButtons() {
        const seen = new Set();
        const buttons = [];

        function addButton(el) {
            if (seen.has(el) || !isVisible(el)) return;
            seen.add(el);

            const allTexts = getButtonText(el);
            if (allTexts.length === 0) return;

            buttons.push({
                element: el,
                texts: allTexts,
                displayText: allTexts[0],
                id: el.id || "",
                selector: getButtonIdentifier(el),
            });
        }

        // Busca ampla de elementos clicaveis
        const selectors = [
            "button",
            'input[type="submit"]',
            'input[type="button"]',
            'input[type="image"]',
            "[role='button']",
            // PrimeFaces
            ".ui-button",
            ".ui-commandlink",
            ".ui-menuitem-link",
            // Bootstrap / generico
            ".btn",
            ".button",
            // PrimeNG/PrimeReact
            ".p-button",
            // Links com onclick
            "a[onclick]",
            "a[href='#']",
            "a[href='javascript:void(0)']",
            // Divs/spans com onclick ou role
            "div[onclick]",
            "span[onclick]",
        ].join(", ");

        document.querySelectorAll(selectors).forEach(addButton);

        // Busca adicional: links (<a>) que contenham texto curto (provavelmente botoes)
        document.querySelectorAll("a").forEach((el) => {
            if (seen.has(el)) return;
            const text = (el.textContent || "").trim();
            // Links com texto curto (< 30 chars) e com href que parece acao (nao URL externa)
            const href = el.getAttribute("href") || "";
            const isAction = !href || href === "#" || href.startsWith("javascript:") || href.includes("void");
            const hasHandler = el.onclick || el.getAttribute("onclick");
            const hasButtonStyle = /btn|button|command|action|link/i.test(el.className || "");
            if (text.length > 0 && text.length < 30 && (isAction || hasHandler || hasButtonStyle)) {
                addButton(el);
            }
        });

        return buttons;
    }

    /**
     * Busca botoes que correspondem a uma lista de termos.
     * Retorna resultados ordenados por relevancia (match exato > parcial > atributo).
     */
    function findButtonByTerms(buttons, terms) {
        const results = [];

        for (const btn of buttons) {
            let bestScore = 0;
            let matchedText = btn.displayText;

            for (const text of btn.texts) {
                const normText = normalize(text);
                for (const term of terms) {
                    const normTerm = normalize(term);
                    let score = 0;

                    // Match exato (maior prioridade)
                    if (normText === normTerm) {
                        score = 100;
                    }
                    // Texto comeca com o termo
                    else if (normText.startsWith(normTerm)) {
                        score = 80;
                    }
                    // Texto contem o termo como palavra (com fronteira)
                    else if (new RegExp("(^|[^a-z])" + normTerm + "([^a-z]|$)").test(normText)) {
                        score = 70;
                    }
                    // Texto contem o termo (substring)
                    else if (normText.includes(normTerm)) {
                        score = 50;
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        matchedText = text;
                    }
                }
            }

            if (bestScore > 0) {
                results.push({
                    text: matchedText.substring(0, 50),
                    id: btn.id,
                    selector: btn.selector,
                    element: btn.element,
                    score: bestScore,
                });
            }
        }

        // Ordena por score (mais relevante primeiro)
        results.sort((a, b) => b.score - a.score);
        return results;
    }

    // ─── Modo de gravacao (recording) ───

    function createRecordingOverlay(type) {
        const overlay = document.createElement("div");
        overlay.id = "__xmlff_recording_overlay__";
        overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:999999;pointer-events:none;background:rgba(0,0,0,0.05);";

        const banner = document.createElement("div");
        banner.style.cssText = "pointer-events:auto;position:absolute;top:0;left:0;right:0;background:rgba(142,68,173,0.95);color:#fff;padding:12px 16px;font-size:14px;font-family:sans-serif;display:flex;justify-content:space-between;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,0.3);";

        const label = type === "save" ? "Salvar" : "Novo";
        const bannerText = document.createElement("span");
        bannerText.textContent = "Clique no botao \"" + label + "\" na pagina";

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancelar (ESC)";
        cancelBtn.style.cssText = "background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);color:#fff;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;";

        banner.appendChild(bannerText);
        banner.appendChild(cancelBtn);
        overlay.appendChild(banner);
        document.body.appendChild(overlay);

        return { overlay, cancelBtn };
    }

    function cleanupRecording() {
        if (!recordingState) return null;
        const pending = recordingState.sendResponse;

        if (recordingState.lastHighlighted) {
            recordingState.lastHighlighted.style.outline = recordingState.lastHighlighted.__xmlff_orig_outline || "";
            recordingState.lastHighlighted.style.outlineOffset = recordingState.lastHighlighted.__xmlff_orig_offset || "";
            delete recordingState.lastHighlighted.__xmlff_orig_outline;
            delete recordingState.lastHighlighted.__xmlff_orig_offset;
        }

        document.removeEventListener("mousemove", recordingState.mousemoveHandler, true);
        document.removeEventListener("click", recordingState.clickHandler, true);
        document.removeEventListener("keydown", recordingState.keydownHandler, true);

        if (recordingState.timeout) clearTimeout(recordingState.timeout);
        if (recordingState.overlay && recordingState.overlay.parentNode) {
            recordingState.overlay.parentNode.removeChild(recordingState.overlay);
        }

        recordingState = null;
        return pending;
    }

    function startRecordingMode(type, sendResponse) {
        if (recordingState) cleanupRecording();

        const { overlay, cancelBtn } = createRecordingOverlay(type);

        recordingState = {
            type,
            overlay,
            sendResponse,
            lastHighlighted: null,
            mousemoveHandler: null,
            clickHandler: null,
            keydownHandler: null,
            timeout: null,
        };

        recordingState.mousemoveHandler = function (e) {
            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || el === overlay || overlay.contains(el)) return;

            if (recordingState.lastHighlighted && recordingState.lastHighlighted !== el) {
                recordingState.lastHighlighted.style.outline = recordingState.lastHighlighted.__xmlff_orig_outline || "";
                recordingState.lastHighlighted.style.outlineOffset = recordingState.lastHighlighted.__xmlff_orig_offset || "";
            }

            if (el !== recordingState.lastHighlighted) {
                el.__xmlff_orig_outline = el.style.outline;
                el.__xmlff_orig_offset = el.style.outlineOffset;
                el.style.outline = "3px solid #8e44ad";
                el.style.outlineOffset = "2px";
                recordingState.lastHighlighted = el;
            }
        };

        recordingState.clickHandler = function (e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();

            const el = document.elementFromPoint(e.clientX, e.clientY);
            if (!el || el === overlay || overlay.contains(el)) return;

            const selector = getButtonIdentifier(el);
            const texts = getButtonText(el);
            const text = texts.length > 0 ? texts[0] : el.tagName;

            const pending = cleanupRecording();
            if (pending) {
                try { pending({ selector: selector, text: text }); } catch (_) { }
            }
        };

        recordingState.keydownHandler = function (e) {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                const pending = cleanupRecording();
                if (pending) {
                    try { pending({ cancelled: true }); } catch (_) { }
                }
            }
        };

        cancelBtn.addEventListener("click", function () {
            const pending = cleanupRecording();
            if (pending) {
                try { pending({ cancelled: true }); } catch (_) { }
            }
        });

        document.addEventListener("mousemove", recordingState.mousemoveHandler, true);
        document.addEventListener("click", recordingState.clickHandler, true);
        document.addEventListener("keydown", recordingState.keydownHandler, true);

        // Timeout de seguranca: 60s
        recordingState.timeout = setTimeout(function () {
            const pending = cleanupRecording();
            if (pending) {
                try { pending({ cancelled: true }); } catch (_) { }
            }
        }, 60000);
    }

    // ─── Message listener ───

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message.action === "ping") {
            sendResponse({ pong: true });
            return true;
        }

        if (message.action === "fillForm") {
            const data = message.data;
            const delay = message.fieldDelay || 400;
            const entries = Object.entries(data).filter(
                ([, v]) => v && typeof v !== "object"
            );

            // Preenche campo a campo com delay (async, orquestrado por promise)
            (async function () {
                const fields = collectFields();
                const results = [];

                for (let i = 0; i < entries.length; i++) {
                    const [xmlKey, xmlValue] = entries[i];

                    // Re-coleta campos a cada iteracao pois novos podem ter surgido
                    // apos preencher um campo anterior (campos condicionais)
                    const currentFields = i > 0 ? collectFields() : fields;
                    // Remove campos ja usados
                    const usedIds = results.filter(r => r.matched).map(r => r._elRef);
                    const availableFields = currentFields.filter(f => !usedIds.includes(f.element));

                    const matchedField = findMatchingField(xmlKey, availableFields);
                    if (matchedField) {
                        const filled = fillField(matchedField, xmlValue, xmlKey);
                        results.push({
                            xmlKey,
                            value: xmlValue,
                            matched: filled,
                            fieldId: matchedField.id,
                            fieldName: matchedField.name,
                            fieldLabel: matchedField.label,
                            _elRef: matchedField.element,
                        });
                    } else {
                        results.push({
                            xmlKey,
                            value: xmlValue,
                            matched: false,
                        });
                    }

                    // Delay entre campos para permitir que o formulario reaja
                    if (i < entries.length - 1) {
                        await new Promise(r => setTimeout(r, delay));
                    }
                }

                // Remove referencia interna antes de enviar
                const cleanResults = results.map(({ _elRef, ...rest }) => rest);
                sendResponse({ results: cleanResults });
            })();

            return true; // indica que sendResponse sera chamado async
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

        if (message.action === "startRecording") {
            startRecordingMode(message.type, sendResponse);
            return true;
        }

        if (message.action === "cancelRecording") {
            const pending = cleanupRecording();
            if (pending) {
                try { pending({ cancelled: true }); } catch (_) { }
            }
            sendResponse({ ok: true });
            return true;
        }

        if (message.action === "detectButtons") {
            const buttons = collectButtons();
            const saveButtons = findButtonByTerms(buttons, SAVE_TERMS);
            const newButtons = findButtonByTerms(buttons, NEW_TERMS);

            sendResponse({
                saveButtons: saveButtons.map(b => ({ text: b.text, id: b.id, selector: b.selector })),
                newButtons: newButtons.map(b => ({ text: b.text, id: b.id, selector: b.selector })),
            });
            return true;
        }

        if (message.action === "clickElement") {
            const { selector, type } = message;

            let btn = null;
            if (selector) {
                btn = document.querySelector(selector);
            }

            // Fallback: auto-deteccao se nao encontrou pelo seletor
            if (!btn) {
                const terms = type === "save" ? SAVE_TERMS : NEW_TERMS;
                const buttons = collectButtons();
                const found = findButtonByTerms(buttons, terms);
                if (found.length > 0) btn = found[0].element;
            }

            if (!btn) {
                sendResponse({ success: false, error: "Botao nao encontrado na pagina." });
                return true;
            }

            highlightElement(btn);
            btn.click();
            sendResponse({ success: true });
            return true;
        }
    });
})();
