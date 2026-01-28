document.getElementById("btnTest").addEventListener("click", () => {
  const out = document.getElementById("out");
  out.textContent = "JS OK ✅  " + new Date().toISOString();
});
