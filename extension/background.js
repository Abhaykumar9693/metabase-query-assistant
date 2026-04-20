// Opens the side panel when the toolbar icon is clicked.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.error("sidePanel setPanelBehavior failed:", e));

// Relay for content script <-> side panel. The side panel and content
// script don't share a document, so we bounce messages through here.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "getActiveTabId") {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      sendResponse({ tabId: tabs[0]?.id ?? null, url: tabs[0]?.url ?? null });
    });
    return true; // async
  }
  if (msg?.type === "forwardToTab" && msg.tabId != null) {
    chrome.tabs.sendMessage(msg.tabId, msg.payload, (response) => {
      sendResponse(response);
    });
    return true; // async
  }
});
