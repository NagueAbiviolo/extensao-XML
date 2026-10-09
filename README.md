<img src="logo.png" alt="logo" width="80" align="right">

# 📄 Preenchedor de Formulários XML

Extensão para Chrome (Manifest V3) que **carrega um arquivo XML e preenche automaticamente** os campos de formulário da página. Foi pensada para acabar com a digitação repetitiva em sistemas web.

## ✨ Funcionalidades

- Leitura e parsing de XML com vários registros
- Identificação inteligente de campos por `id`, `name`, `label`, `aria-label` e sinônimos (ex.: `cidade`, `municipio`, `xMun`)
- Escaneamento dos campos da página antes de preencher
- **Preenchimento em lote**: percorre um intervalo de registros e salva cada um automaticamente
- Botões de salvar e de "novo" configuráveis: basta apontar o elemento na página
- Relatório do resultado do preenchimento

## 🚀 Instalação

1. Clone ou baixe este repositório
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto

## 🛠️ Tecnologias

JavaScript · Chrome Extensions API (Manifest V3) · HTML/CSS
