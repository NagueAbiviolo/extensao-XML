/**
 * Popup script da extensão XML Form Filler.
 * Gerencia upload de XML, preview dos dados e comunicação com o content script.
 */

(() => {
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

    let parsedData = null;

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
        fileInput.value = "";
        fileInfo.classList.add("hidden");
        preview.classList.add("hidden");
        resultArea.classList.add("hidden");
        uploadArea.classList.remove("hidden");
        btnFill.disabled = true;
        hideStatus();
    });

    // ─── Actions ───

    btnFill.addEventListener("click", async () => {
        if (!parsedData) return;
        btnFill.disabled = true;
        showStatus("Preenchendo formulário...", "info");

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: "fillForm",
                data: parsedData,
            });

            if (response && response.results) {
                showResults(response.results);
                const matched = response.results.filter((r) => r.matched).length;
                const total = response.results.length;
                if (matched > 0) {
                    showStatus(`${matched} de ${total} campos preenchidos com sucesso!`, "success");
                } else {
                    showStatus("Nenhum campo correspondente encontrado na página.", "error");
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
        showStatus("Escaneando campos do formulário...", "info");

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const response = await chrome.tabs.sendMessage(tab.id, {
                action: "scanFields",
            });

            if (response && response.fields) {
                const count = response.fields.length;
                if (count === 0) {
                    showStatus("Nenhum campo de formulário encontrado na página.", "error");
                } else {
                    showStatus(`${count} campos de formulário encontrados na página.`, "success");
                    // Mostra os campos no result area
                    resultArea.classList.remove("hidden");
                    resultList.innerHTML = response.fields
                        .map(
                            (f) =>
                                `<div class="result-item matched">
                  <span class="result-icon">📋</span>
                  <span><strong>${f.type}</strong> — id: ${f.id || "(sem id)"} | name: ${f.name || "(sem name)"} | label: ${f.label || ""}</span>
                </div>`
                        )
                        .join("");
                }
            }
        } catch (err) {
            showStatus("Erro: " + err.message, "error");
        }
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
                const keys = Object.keys(parsedData);

                if (keys.length === 0) {
                    showStatus("Nenhum dado extraído do XML.", "error");
                    return;
                }

                // Mostra info do arquivo
                fileName.textContent = `✓ ${file.name}`;
                fileInfo.classList.remove("hidden");
                uploadArea.classList.add("hidden");

                // Preview
                dataCount.textContent = keys.length;
                dataList.innerHTML = keys
                    .map(
                        (key) =>
                            `<div class="data-item">
                <span class="data-key">${escapeHtml(key)}</span>
                <span class="data-value">${escapeHtml(truncate(parsedData[key], 60))}</span>
              </div>`
                    )
                    .join("");
                preview.classList.remove("hidden");
                resultArea.classList.add("hidden");

                btnFill.disabled = false;
                showStatus(`${keys.length} campos extraídos do XML.`, "success");
            } catch (err) {
                showStatus("Erro ao ler XML: " + err.message, "error");
            }
        };
        reader.readAsText(file);
    }

    function showResults(results) {
        resultArea.classList.remove("hidden");
        resultList.innerHTML = results
            .map(
                (r) =>
                    `<div class="result-item ${r.matched ? "matched" : "unmatched"}">
            <span class="result-icon">${r.matched ? "✅" : "⬜"}</span>
            <span><strong>${escapeHtml(r.xmlKey)}</strong> → ${r.matched
                        ? `${escapeHtml(r.fieldId || r.fieldName)} = "${escapeHtml(truncate(r.value, 40))}"`
                        : "sem correspondência"
                    }</span>
          </div>`
            )
            .join("");
    }

    function showStatus(msg, type) {
        status.textContent = msg;
        status.className = `status ${type}`;
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
