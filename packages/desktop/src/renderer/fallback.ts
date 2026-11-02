const message = new URLSearchParams(window.location.search).get("error");
const errorElement = document.querySelector<HTMLElement>("#load-error");

if (message && errorElement) {
  errorElement.textContent = `完整界面加载失败：${message}`;
  errorElement.hidden = false;
}

export {};
