const TARGET_ADDRESS = "0xb19262185bac9748e2b71674Ef48676448F7A516";
const BASE_CHAIN_ID = "0x2105";
const BASE_CHAIN_DECIMAL = 8453;

const connectButton = document.querySelector("#connect-wallet");
const switchBaseButton = document.querySelector("#switch-base");
const signerForm = document.querySelector("#signer");
const methodSelect = document.querySelector("#sign-method");
const challengeInput = document.querySelector("#challenge");
const output = document.querySelector("#signature-output");
const statusText = document.querySelector("#signer-status");
const connectedAddress = document.querySelector("#connected-address");
const chainStatus = document.querySelector("#chain-status");
const copyButton = document.querySelector("#copy-output");

let provider = getProvider();
let currentAddress = "";
let currentChainId = "";

connectButton.addEventListener("click", connectWallet);
switchBaseButton.addEventListener("click", switchToBase);
signerForm.addEventListener("submit", signChallenge);
copyButton.addEventListener("click", copyResult);

if (provider?.on) {
  provider.on("accountsChanged", (accounts) => {
    currentAddress = accounts?.[0] || "";
    updateWalletStatus();
  });
  provider.on("chainChanged", (chainId) => {
    currentChainId = normalizeChainId(chainId);
    updateWalletStatus();
  });
}

updateWalletStatus();
hydrateFromUrlParams();

function getProvider() {
  if (!window.ethereum) return null;
  if (Array.isArray(window.ethereum.providers)) {
    return (
      window.ethereum.providers.find((item) => item.isCoinbaseWallet) ||
      window.ethereum.providers.find((item) => item.isMetaMask) ||
      window.ethereum.providers[0]
    );
  }
  return window.ethereum;
}

function hydrateFromUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const method = params.get("method");
  const challenge =
    params.get("challenge") || params.get("message") || params.get("typedData");
  const source = params.get("source");

  if (method && [...methodSelect.options].some((option) => option.value === method)) {
    methodSelect.value = method;
  }
  if (challenge) {
    challengeInput.value = challenge;
    output.textContent = [
      source ? `Challenge loaded for ${source}.` : "Challenge loaded from URL.",
      "Connect the target wallet, switch to Base if needed, then sign.",
      "Copy the resulting JSON back to Codex.",
    ].join("\n");
    setStatus("Challenge loaded from URL.");
  }
}

async function connectWallet() {
  provider = getProvider();
  if (!provider) {
    setStatus("Open this page inside Coinbase Wallet or MetaMask.", true);
    return;
  }

  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    currentAddress = accounts?.[0] || "";
    currentChainId = normalizeChainId(
      await provider.request({ method: "eth_chainId" }),
    );
    updateWalletStatus();
  } catch (error) {
    setStatus(error.message || "Wallet connection failed.", true);
  }
}

async function switchToBase() {
  if (!provider) {
    setStatus("Connect a wallet first.", true);
    return;
  }

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID }],
    });
    currentChainId = BASE_CHAIN_ID;
    updateWalletStatus();
  } catch (error) {
    if (error.code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_CHAIN_ID,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
      currentChainId = BASE_CHAIN_ID;
      updateWalletStatus();
      return;
    }
    setStatus(error.message || "Could not switch to Base.", true);
  }
}

async function signChallenge(event) {
  event.preventDefault();
  if (!provider || !currentAddress) {
    setStatus("Connect the target wallet first.", true);
    return;
  }
  if (!isTargetWallet(currentAddress)) {
    setStatus("Connected wallet does not match the target wallet.", true);
    return;
  }

  const method = methodSelect.value;
  const challenge = challengeInput.value.trim();
  if (!challenge) {
    setStatus("Paste a challenge before signing.", true);
    return;
  }

  try {
    const signature =
      method === "eth_signTypedData_v4"
        ? await signTypedData(challenge)
        : await provider.request({
            method: "personal_sign",
            params: [challenge, currentAddress],
          });

    const payload = {
      address: currentAddress,
      targetAddress: TARGET_ADDRESS,
      chainId: parseInt(currentChainId || BASE_CHAIN_ID, 16),
      method,
      message:
        method === "eth_signTypedData_v4" ? JSON.parse(challenge) : challenge,
      signature,
      signedAt: new Date().toISOString(),
    };

    output.textContent = JSON.stringify(payload, null, 2);
    setStatus("Signature ready.");
  } catch (error) {
    setStatus(error.message || "Signing failed.", true);
  }
}

async function signTypedData(rawTypedData) {
  const typedData = JSON.parse(rawTypedData);
  return provider.request({
    method: "eth_signTypedData_v4",
    params: [currentAddress, JSON.stringify(typedData)],
  });
}

async function copyResult() {
  const text = output.textContent.trim();
  if (!text || text === "Connect the target wallet to start.") {
    setStatus("Nothing to copy yet.", true);
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setStatus("Copied.");
  } catch (error) {
    setStatus(error.message || "Copy failed.", true);
  }
}

function updateWalletStatus() {
  connectedAddress.textContent = currentAddress || "Not connected";
  chainStatus.textContent = currentChainId
    ? `${parseInt(currentChainId, 16)}${currentChainId === BASE_CHAIN_ID ? " Base" : ""}`
    : "Waiting for wallet";

  if (!provider) {
    setStatus("Wallet browser required.", true);
    return;
  }
  if (!currentAddress) {
    setStatus("Ready.");
    return;
  }
  if (!isTargetWallet(currentAddress)) {
    setStatus("Wrong wallet connected.", true);
    return;
  }
  if (currentChainId && currentChainId !== BASE_CHAIN_ID) {
    setStatus(`Switch to Base chain ${BASE_CHAIN_DECIMAL}.`, true);
    return;
  }
  setStatus("Target wallet connected.");
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.closest(".status-line").classList.toggle("error", isError);
}

function isTargetWallet(address) {
  return address.toLowerCase() === TARGET_ADDRESS.toLowerCase();
}

function normalizeChainId(chainId) {
  if (typeof chainId === "number") return `0x${chainId.toString(16)}`;
  return String(chainId || "").toLowerCase();
}
