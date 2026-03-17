/**
 * Popup script da extensão XML Form Filler.
 * Gerencia upload de XML, preview dos dados e comunicação com o content script.
 */

(() => {
    // Helper: busca a aba ativa na ultima janela normal do navegador
    // e garante que o content script esta injetado
    async function getActiveTab() {
        const extUrl = chrome.runtime.getURL("");

        let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        let tab = tabs.find(t => t.url && !t.url.startsWith(extUrl) && !t.url.startsWith("chrome://"));

        if (!tab) {
            tabs = await chrome.tabs.query({ active: true, windowType: "normal" });
            tab = tabs.find(t => t.url && !t.url.startsWith(extUrl) && !t.url.startsWith("chrome://"));
        }

        if (!tab) return null;

        // Espera a pagina terminar de carregar (se estiver recarregando)
        tab = await waitForTabComplete(tab.id);

        try {
            await chrome.tabs.sendMessage(tab.id, { action: "ping" });
        } catch {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["content.js"],
            });
            // Pequena espera para o script inicializar
            await sleep(200);
        }

        return tab;
    }

    // Espera ate a aba terminar de carregar (status === "complete")
    function waitForTabComplete(tabId, timeout) {
        timeout = timeout || 15000;
        return new Promise((resolve, reject) => {
            let elapsed = 0;
            const interval = 300;

            function check() {
                chrome.tabs.get(tabId, (tab) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error("Aba nao encontrada."));
                        return;
                    }
                    if (tab.status === "complete") {
                        resolve(tab);
                    } else if (elapsed >= timeout) {
                        resolve(tab); // Continua mesmo se nao completou
                    } else {
                        elapsed += interval;
                        setTimeout(check, interval);
                    }
                });
            }
            check();
        });
    }

    // ─── DOM refs ───

    const uploadArea = document.getElementById("uploadArea");
    const fileInput = document.getElementById("fileInput");
    const fileInfo = document.getElementById("fileInfo");
    const fileName = document.getElementById("fileName");
    const btnRemove = document.getElementById("btnRemove");
    const preview = document.getElementById("preview");
    const dataCount = document.getElementById("dataCount");
    const dataList = document.getElementById("dataList");
    const resultArea = document.getElementById("resultArea");
    const resultList = document.getElementById("resultList");
    const btnFill = document.getElementById("btnFill");
    const btnScan = document.getElementById("btnScan");
    const status = document.getElementById("status");
    const groupSelector = document.getElementById("groupSelector");
    const groupCount = document.getElementById("groupCount");
    const groupList = document.getElementById("groupList");
    const groupPreview = document.getElementById("groupPreview");
    const groupDataList = document.getElementById("groupDataList");

    const configToggle = document.getElementById("configToggle");
    const configPanel = document.getElementById("configPanel");
    const configStatusDot = document.getElementById("configStatusDot");
    const configToggleLabel = document.getElementById("configToggleLabel");
    const processList = document.getElementById("processList");
    const processName = document.getElementById("processName");
    const btnSaveProcess = document.getElementById("btnSaveProcess");
    const btnDeleteProcess = document.getElementById("btnDeleteProcess");

    const saveBtnStatus = document.getElementById("saveBtnStatus");
    const saveBtnText = document.getElementById("saveBtnText");
    const btnPickSave = document.getElementById("btnPickSave");
    const btnEditSave = document.getElementById("btnEditSave");
    const saveSelectorManual = document.getElementById("saveSelectorManual");
    const saveSelector = document.getElementById("saveSelector");
    const btnCloseSaveManual = document.getElementById("btnCloseSaveManual");

    const newBtnStatus = document.getElementById("newBtnStatus");
    const newBtnText = document.getElementById("newBtnText");
    const btnPickNew = document.getElementById("btnPickNew");
    const btnEditNew = document.getElementById("btnEditNew");
    const newSelectorManual = document.getElementById("newSelectorManual");
    const newSelector = document.getElementById("newSelector");
    const btnCloseNewManual = document.getElementById("btnCloseNewManual");

    const saveDelay = document.getElementById("saveDelay");
    const execDescription = document.getElementById("execDescription");
    const btnSaveNew = document.getElementById("btnSaveNew");

    const batchConfig = document.getElementById("batchConfig");
    const batchFrom = document.getElementById("batchFrom");
    const batchTo = document.getElementById("batchTo");
    const batchDescription = document.getElementById("batchDescription");
    const batchProgress = document.getElementById("batchProgress");
    const batchProgressFill = document.getElementById("batchProgressFill");
    const batchProgressText = document.getElementById("batchProgressText");
    const btnCancelBatch = document.getElementById("btnCancelBatch");

    let parsedData = null;
    let selectedGroupIndex = -1;
    let batchCancelled = false;

    // ─── Automation state ───

    let processes = [];
    let isRecording = false;
    let recordingType = null;
    let currentSaveButtonText = "";
    let currentNewButtonText = "";

    // ─── UI update helpers ───

    function updateButtonUI(type) {
        const selector = type === "save" ? saveSelector.value.trim() : newSelector.value.trim();
        const text = type === "save" ? currentSaveButtonText : currentNewButtonText;
        const statusIcon = type === "save" ? saveBtnStatus : newBtnStatus;
        const textSpan = type === "save" ? saveBtnText : newBtnText;
        const editBtn = type === "save" ? btnEditSave : btnEditNew;

        if (selector) {
            statusIcon.className = "btn-status-icon configured";
            textSpan.textContent = text || selector;
            textSpan.classList.remove("not-configured");
            editBtn.classList.remove("hidden");
        } else {
            statusIcon.className = "btn-status-icon";
            textSpan.textContent = "Nao configurado";
            textSpan.classList.add("not-configured");
            editBtn.classList.add("hidden");
        }

        updateExecState();
    }

    function updateExecState() {
        const hasSave = saveSelector.value.trim() !== "";
        const hasNew = newSelector.value.trim() !== "";
        const delay = parseInt(saveDelay.value) || 2000;

        btnSaveNew.disabled = !hasSave || !hasNew;

        if (hasSave && hasNew) {
            const sName = currentSaveButtonText || "Salvar";
            const nName = currentNewButtonText || "Novo";
            execDescription.textContent = "Vai clicar em [" + sName + "] → esperar " + (delay / 1000) + "s → clicar em [" + nName + "]";
            configStatusDot.className = "status-dot green";
        } else if (hasSave || hasNew) {
            execDescription.textContent = "Configure os dois botoes para habilitar.";
            configStatusDot.className = "status-dot yellow";
        } else {
            execDescription.textContent = "Configure os botoes acima para habilitar.";
            configStatusDot.className = "status-dot gray";
        }
    }

    function updateToggleLabel() {
        const active = processList.value;
        if (active) {
            configToggleLabel.textContent = active;
        } else {
            configToggleLabel.textContent = "Nenhum processo";
        }
    }

    // ─── Config toggle ───

    configToggle.addEventListener("click", () => {
        const isOpen = !configPanel.classList.contains("hidden");
        configPanel.classList.toggle("hidden");
        configToggle.classList.toggle("open", !isOpen);
    });

    // ─── Process management ───

    function renderProcessList(activeName) {
        processList.innerHTML = '<option value="">-- Selecione --</option>';
        processes.forEach((p) => {
            const opt = document.createElement("option");
            opt.value = p.name;
            opt.textContent = p.name;
            if (p.name === activeName) opt.selected = true;
            processList.appendChild(opt);
        });
    }

    function loadProcesses() {
        chrome.storage.local.get(["automationProcesses", "activeProcess"], (result) => {
            processes = result.automationProcesses || [];
            const active = result.activeProcess || "";
            renderProcessList(active);
            if (active) {
                applyProcess(active);
            }
            updateToggleLabel();
            updateExecState();
        });
    }

    function applyProcess(name) {
        const proc = processes.find((p) => p.name === name);
        if (proc) {
            saveSelector.value = proc.saveSelector || "";
            newSelector.value = proc.newSelector || "";
            saveDelay.value = proc.delay || 2000;
            processName.value = proc.name;
            currentSaveButtonText = proc.saveButtonText || "";
            currentNewButtonText = proc.newButtonText || "";
            updateButtonUI("save");
            updateButtonUI("new");
            updateToggleLabel();
        }
    }

    function saveProcesses(activeName) {
        chrome.storage.local.set({
            automationProcesses: processes,
            activeProcess: activeName || "",
        });
    }

    loadProcesses();

    processList.addEventListener("change", () => {
        const name = processList.value;
        if (name) {
            applyProcess(name);
            saveProcesses(name);
            showStatus("Processo \"" + name + "\" carregado.", "success");
        } else {
            saveSelector.value = "";
            newSelector.value = "";
            saveDelay.value = 2000;
            processName.value = "";
            currentSaveButtonText = "";
            currentNewButtonText = "";
            saveProcesses("");
            updateButtonUI("save");
            updateButtonUI("new");
            updateToggleLabel();
        }
    });

    btnSaveProcess.addEventListener("click", () => {
        const name = processName.value.trim();
        if (!name) {
            showStatus("Digite um nome para o processo.", "error");
            return;
        }

        const config = {
            name,
            saveSelector: saveSelector.value.trim(),
            saveButtonText: currentSaveButtonText,
            newSelector: newSelector.value.trim(),
            newButtonText: currentNewButtonText,
            delay: parseInt(saveDelay.value) || 2000,
        };

        const idx = processes.findIndex((p) => p.name === name);
        if (idx >= 0) {
            processes[idx] = config;
        } else {
            processes.push(config);
        }

        saveProcesses(name);
        renderProcessList(name);
        updateToggleLabel();
        showStatus("Processo \"" + name + "\" salvo!", "success");
    });

    btnDeleteProcess.addEventListener("click", () => {
        const name = processList.value;
        if (!name) {
            showStatus("Selecione um processo para excluir.", "error");
            return;
        }

        processes = processes.filter((p) => p.name !== name);
        saveProcesses("");
        renderProcessList("");
        saveSelector.value = "";
        newSelector.value = "";
        saveDelay.value = 2000;
        processName.value = "";
        currentSaveButtonText = "";
        currentNewButtonText = "";
        updateButtonUI("save");
        updateButtonUI("new");
        updateToggleLabel();
        showStatus("Processo \"" + name + "\" excluido.", "success");
    });

    function onFieldChange() {
        const active = processList.value;
        if (active) {
            const proc = processes.find((p) => p.name === active);
            if (proc) {
                proc.saveSelector = saveSelector.value.trim();
                proc.saveButtonText = currentSaveButtonText;
                proc.newSelector = newSelector.value.trim();
                proc.newButtonText = currentNewButtonText;
                proc.delay = parseInt(saveDelay.value) || 2000;
                saveProcesses(active);
            }
        }
        updateExecState();
    }

    saveSelector.addEventListener("input", () => { updateButtonUI("save"); onFieldChange(); });
    newSelector.addEventListener("input", () => { updateButtonUI("new"); onFieldChange(); });
    saveDelay.addEventListener("change", onFieldChange);

    // ─── Recording mode (pick buttons visually) ───

    async function startPickMode(type) {
        if (isRecording) return;
        isRecording = true;
        recordingType = type;

        const pickBtn = type === "save" ? btnPickSave : btnPickNew;
        pickBtn.textContent = "Cancelar";
        pickBtn.classList.add("recording");

        try {
            const tab = await getActiveTab();
            if (!tab) {
                showStatus("Nenhuma aba ativa encontrada.", "error");
                return;
            }

            const response = await chrome.tabs.sendMessage(tab.id, {
                action: "startRecording",
                type: type,
            });

            if (response && !response.cancelled) {
                if (type === "save") {
                    saveSelector.value = response.selector || "";
                    currentSaveButtonText = response.text || "";
                } else {
                    newSelector.value = response.selector || "";
                    currentNewButtonText = response.text || "";
                }
                updateButtonUI(type);
                onFieldChange();
                showStatus("Botao \"" + (response.text || "") + "\" selecionado!", "success");
            } else {
                showStatus("Selecao cancelada.", "info");
            }
        } catch (err) {
            showStatus("Erro: " + err.message, "error");
        } finally {
            pickBtn.textContent = "Apontar";
            pickBtn.classList.remove("recording");
            isRecording = false;
            recordingType = null;
        }
    }

    async function cancelPickMode() {
        if (!isRecording) return;
        try {
            const tab = await getActiveTab();
            if (tab) {
                await chrome.tabs.sendMessage(tab.id, { action: "cancelRecording" });
            }
        } catch (_) { }
    }

    btnPickSave.addEventListener("click", () => {
        if (isRecording && recordingType === "save") {
            cancelPickMode();
        } else {
            startPickMode("save");
        }
    });

    btnPickNew.addEventListener("click", () => {
        if (isRecording && recordingType === "new") {
            cancelPickMode();
        } else {
            startPickMode("new");
        }
    });

    // Manual selector toggle
    btnEditSave.addEventListener("click", () => {
        saveSelectorManual.classList.toggle("hidden");
    });
    btnEditNew.addEventListener("click", () => {
        newSelectorManual.classList.toggle("hidden");
    });
    btnCloseSaveManual.addEventListener("click", () => {
        saveSelectorManual.classList.add("hidden");
        updateButtonUI("save");
        onFieldChange();
    });
    btnCloseNewManual.addEventListener("click", () => {
        newSelectorManual.classList.add("hidden");
        updateButtonUI("new");
        onFieldChange();
    });

    // Cleanup on popup close
    window.addEventListener("unload", () => {
        if (isRecording) {
            getActiveTab().then(tab => {
                if (tab) chrome.tabs.sendMessage(tab.id, { action: "cancelRecording" });
            }).catch(() => {});
        }
    });

    // ─── Upload ───

    uploadArea.addEventListener("click", () => fileInput.click());

    uploadArea.addEventListener("dragover", (e) => {
        e.preventDefault();
        uploadArea.classList.add("dragover");
    });

    uploadArea.addEventListener("dragleave", () => {
        uploadArea.classList.remove("dragover");
    });

    uploadArea.addEventListener("drop", (e) => {
        e.preventDefault();
        uploadArea.classList.remove("dragover");
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            handleFile(files[0]);
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            handleFile(fileInput.files[0]);
        }
    });

    btnRemove.addEventListener("click", () => {
        parsedData = null;
        selectedGroupIndex = -1;
        fileInput.value = "";
        fileInfo.classList.add("hidden");
        preview.classList.add("hidden");
        groupSelector.classList.add("hidden");
        batchConfig.classList.add("hidden");
        resultArea.classList.add("hidden");
        uploadArea.classList.remove("hidden");
        btnFill.disabled = true;
        hideStatus();
    });

    // ─── Actions ───

    btnFill.addEventListener("click", async () => {
        if (!parsedData) return;
        btnFill.disabled = true;
        showStatus("Preenchendo formulario...", "info");

        try {
            const tab = await getActiveTab();
            const dataToSend = Object.assign({}, parsedData.fields);
            if (selectedGroupIndex >= 0 && parsedData.groups[selectedGroupIndex]) {
                Object.assign(dataToSend, parsedData.groups[selectedGroupIndex].fields);
            }
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: "fillForm",
                data: dataToSend,
            });

            if (response && response.results) {
                showResults(response.results);
                const matched = response.results.filter((r) => r.matched).length;
                const total = response.results.length;
                if (matched > 0) {
                    showStatus(matched + " de " + total + " campos preenchidos com sucesso!", "success");
                } else {
                    showStatus("Nenhum campo correspondente encontrado na pagina.", "error");
                }
            } else {
                showStatus("Erro: sem resposta do content script.", "error");
            }
        } catch (err) {
            showStatus("Erro: " + err.message, "error");
        }

        btnFill.disabled = false;
    });

    btnScan.addEventListener("click", async () => {
        showStatus("Escaneando campos do formulario...", "info");

        try {
            const tab = await getActiveTab();
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: "scanFields",
            });

            if (response && response.fields) {
                const count = response.fields.length;
                if (count === 0) {
                    showStatus("Nenhum campo de formulario encontrado na pagina.", "error");
                } else {
                    showStatus(count + " campos de formulario encontrados na pagina.", "success");
                    resultArea.classList.remove("hidden");
                    resultList.innerHTML = response.fields
                        .map(
                            (f) =>
                                '<div class="result-item matched"><span class="result-icon">📋</span><span><strong>' + escapeHtml(f.type) + '</strong> — id: ' + (f.id || "(sem id)") + ' | name: ' + (f.name || "(sem name)") + ' | label: ' + (f.label || "") + '</span></div>'
                        )
                        .join("");
                }
            }
        } catch (err) {
            showStatus("Erro: " + err.message, "error");
        }
    });

    // ─── Popup-orchestrated save-and-new flow ───

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function clickOnPage(selector, type) {
        const tab = await getActiveTab();
        if (!tab) throw new Error("Nenhuma aba ativa encontrada.");

        // Tenta ate 3 vezes (a pagina pode ainda estar renderizando)
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: "clickElement",
                    selector: selector || "",
                    type: type,
                });
                if (response && response.success) return;
                lastError = response?.error || "Botao nao encontrado.";
            } catch (err) {
                lastError = err.message;
            }
            // Espera antes de tentar novamente
            await sleep(500);
            // Re-injeta se necessario
            try {
                await chrome.tabs.sendMessage(tab.id, { action: "ping" });
            } catch {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ["content.js"],
                });
                await sleep(300);
            }
        }
        throw new Error(lastError || "Botao nao encontrado apos 3 tentativas.");
    }

    async function fillOnPage(data) {
        const tab = await getActiveTab();
        if (!tab) throw new Error("Nenhuma aba ativa encontrada.");

        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: "fillForm",
                    data: data,
                });
                if (response && response.results) return response;
                lastError = "Sem resposta do content script.";
            } catch (err) {
                lastError = err.message;
            }
            await sleep(500);
            try {
                await chrome.tabs.sendMessage(tab.id, { action: "ping" });
            } catch {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ["content.js"],
                });
                await sleep(300);
            }
        }
        throw new Error(lastError || "Falha ao preencher formulario apos 3 tentativas.");
    }

    function getDataForGroup(groupIndex) {
        if (!parsedData) return {};
        const data = Object.assign({}, parsedData.fields);
        if (groupIndex >= 0 && parsedData.groups[groupIndex]) {
            Object.assign(data, parsedData.groups[groupIndex].fields);
        }
        return data;
    }

    btnSaveNew.addEventListener("click", async () => {
        const saveSel = saveSelector.value.trim();
        const newSel = newSelector.value.trim();
        const delay = parseInt(saveDelay.value) || 2000;

        const hasGroups = parsedData && parsedData.groups.length > 0;
        const isBatch = hasGroups && batchFrom.value !== "" && batchTo.value !== "";

        if (isBatch) {
            // ─── Batch processing ───
            const fromIdx = parseInt(batchFrom.value);
            const toIdx = parseInt(batchTo.value);
            const total = toIdx - fromIdx + 1;

            if (total <= 0) {
                showStatus("Intervalo invalido. 'De' deve ser menor ou igual a 'Ate'.", "error");
                return;
            }

            batchCancelled = false;
            btnSaveNew.disabled = true;
            batchProgress.classList.remove("hidden");

            for (let i = fromIdx; i <= toIdx; i++) {
                if (batchCancelled) {
                    showStatus("Processamento interrompido no registro " + (i + 1) + ".", "info");
                    break;
                }

                const current = i - fromIdx + 1;
                const pct = Math.round((current / total) * 100);
                batchProgressFill.style.width = pct + "%";
                batchProgressText.textContent = current + "/" + total;

                try {
                    // 1. Preencher formulario com dados do registro
                    showStatus("Preenchendo registro " + (i + 1) + "...", "info");
                    const data = getDataForGroup(i);
                    await fillOnPage(data);

                    // 2. Clicar em Salvar
                    showStatus("Salvando registro " + (i + 1) + "...", "info");
                    await clickOnPage(saveSel, "save");

                    // 3. Esperar (pagina pode recarregar)
                    await sleep(delay);

                    // 4. Clicar em Novo (se nao for o ultimo registro)
                    if (i < toIdx) {
                        showStatus("Clicando em Novo...", "info");
                        await clickOnPage(newSel, "new");
                        // Espera extra para o formulario novo carregar
                        await sleep(Math.min(delay, 2000));
                    }
                } catch (err) {
                    showStatus("Erro no registro " + (i + 1) + ": " + err.message, "error");
                    break;
                }
            }

            batchProgress.classList.add("hidden");
            batchProgressFill.style.width = "0%";
            btnSaveNew.disabled = false;

            if (!batchCancelled) {
                showStatus("Lote concluido! " + total + " registros processados.", "success");
            }
        } else {
            // ─── Single save-and-new ───
            btnSaveNew.disabled = true;
            showStatus("Clicando em Salvar...", "info");

            try {
                await clickOnPage(saveSel, "save");
                showStatus("Salvo! Aguardando " + (delay / 1000) + "s...", "info");
                await sleep(delay);

                showStatus("Clicando em Novo...", "info");
                await clickOnPage(newSel, "new");
                showStatus("Salvo com sucesso! Formulario pronto para novo registro.", "success");
            } catch (err) {
                showStatus("Erro: " + err.message, "error");
            }

            btnSaveNew.disabled = false;
        }
    });

    btnCancelBatch.addEventListener("click", () => {
        batchCancelled = true;
    });

    // ─── Handlers ───

    function handleFile(file) {
        if (!file.name.toLowerCase().endsWith(".xml")) {
            showStatus("Por favor, selecione um arquivo .xml", "error");
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                parsedData = XmlParser.parse(e.target.result);
                selectedGroupIndex = -1;
                const keys = Object.keys(parsedData.fields);
                const hasGroups = parsedData.groups.length > 0;

                if (keys.length === 0 && !hasGroups) {
                    showStatus("Nenhum dado extraido do XML.", "error");
                    return;
                }

                fileName.textContent = file.name;
                fileInfo.classList.remove("hidden");
                uploadArea.classList.add("hidden");

                if (keys.length > 0) {
                    dataCount.textContent = keys.length;
                    dataList.innerHTML = keys
                        .map(
                            (key) =>
                                '<div class="data-item"><span class="data-key">' + escapeHtml(key) + '</span><span class="data-value">' + escapeHtml(truncate(parsedData.fields[key], 60)) + '</span></div>'
                        )
                        .join("");
                    preview.classList.remove("hidden");
                } else {
                    preview.classList.add("hidden");
                }

                if (hasGroups) {
                    renderGroupSelector(parsedData.groups);
                } else {
                    groupSelector.classList.add("hidden");
                    batchConfig.classList.add("hidden");
                }

                resultArea.classList.add("hidden");
                btnFill.disabled = false;

                const parts = [];
                if (keys.length > 0) parts.push(keys.length + " campos base extraidos");
                if (hasGroups) parts.push(parsedData.groups.length + " registros encontrados");
                showStatus(parts.join(" + ") + ".", "success");
            } catch (err) {
                showStatus("Erro ao ler XML: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    }

    function renderGroupSelector(groups) {
        groupCount.textContent = groups.length;
        groupList.innerHTML = groups
            .map(
                (g, i) =>
                    '<div class="group-item ' + (i === selectedGroupIndex ? "selected" : "") + '" data-index="' + i + '"><span class="group-radio">' + (i === selectedGroupIndex ? "◉" : "○") + '</span><span class="group-label">' + escapeHtml(g.label) + '</span><span class="group-field-count">' + Object.keys(g.fields).length + ' campos</span></div>'
            )
            .join("");

        groupList.querySelectorAll(".group-item").forEach((item) => {
            item.addEventListener("click", () => {
                const idx = parseInt(item.dataset.index);
                if (selectedGroupIndex === idx) {
                    selectedGroupIndex = -1;
                    groupPreview.classList.add("hidden");
                } else {
                    selectedGroupIndex = idx;
                    showGroupPreview(groups[idx]);
                }
                renderGroupSelector(groups);
            });
        });

        groupSelector.classList.remove("hidden");

        // Atualiza seletores de lote
        updateBatchSelectors(groups);
    }

    function updateBatchSelectors(groups) {
        batchFrom.innerHTML = "";
        batchTo.innerHTML = "";

        groups.forEach((g, i) => {
            const optFrom = document.createElement("option");
            optFrom.value = i;
            optFrom.textContent = (i + 1) + " - " + truncate(g.label, 25);
            batchFrom.appendChild(optFrom);

            const optTo = document.createElement("option");
            optTo.value = i;
            optTo.textContent = (i + 1) + " - " + truncate(g.label, 25);
            batchTo.appendChild(optTo);
        });

        // Pre-seleciona: do primeiro ao ultimo
        batchFrom.value = "0";
        batchTo.value = String(groups.length - 1);

        updateBatchDescription();
        batchConfig.classList.remove("hidden");
    }

    function updateBatchDescription() {
        const from = parseInt(batchFrom.value);
        const to = parseInt(batchTo.value);
        if (isNaN(from) || isNaN(to)) return;
        const total = to - from + 1;
        if (total > 0) {
            batchDescription.textContent = "Vai processar " + total + " registro(s): preencher → salvar → novo, para cada um.";
        } else {
            batchDescription.textContent = "Intervalo invalido.";
        }
    }

    batchFrom.addEventListener("change", updateBatchDescription);
    batchTo.addEventListener("change", updateBatchDescription);

    function showGroupPreview(group) {
        const keys = Object.keys(group.fields);
        groupDataList.innerHTML = keys
            .map(
                (key) =>
                    '<div class="data-item"><span class="data-key">' + escapeHtml(key) + '</span><span class="data-value">' + escapeHtml(truncate(group.fields[key], 60)) + '</span></div>'
            )
            .join("");
        groupPreview.classList.remove("hidden");
    }

    function showResults(results) {
        resultArea.classList.remove("hidden");
        resultList.innerHTML = results
            .map(
                (r) =>
                    '<div class="result-item ' + (r.matched ? "matched" : "unmatched") + '"><span class="result-icon">' + (r.matched ? "✅" : "⬜") + '</span><span><strong>' + escapeHtml(r.xmlKey) + '</strong> → ' + (r.matched ? escapeHtml(r.fieldId || r.fieldName) + ' = "' + escapeHtml(truncate(r.value, 40)) + '"' : "sem correspondencia") + '</span></div>'
            )
            .join("");
    }

    function showStatus(msg, type) {
        status.textContent = msg;
        status.className = "status " + type;
        status.classList.remove("hidden");
    }

    function hideStatus() {
        status.classList.add("hidden");
    }

    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function truncate(str, max) {
        if (!str) return "";
        return str.length > max ? str.substring(0, max) + "…" : str;
    }
})();
