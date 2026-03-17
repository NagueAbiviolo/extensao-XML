/**
 * Background service worker da extensão Preenchedor de Formulários XML.
 * Abre a popup em uma janela independente ao clicar no ícone.
 */

chrome.action.onClicked.addListener(async (tab) => {
    const width = 460;
    const height = 600;

    // Pega a janela atual para centralizar
    const currentWindow = await chrome.windows.getCurrent();
    const left = Math.round(currentWindow.left + (currentWindow.width - width) / 2);
    const top = Math.round(currentWindow.top + (currentWindow.height - height) / 2);

    await chrome.windows.create({
        url: chrome.runtime.getURL("popup.html"),
        type: "popup",
        width,
        height,
        left,
        top,
    });
});
