// ================= AUTENTICACAO DO USUARIO =================
async function login() {
  const user = document.getElementById("user").value;
  const pass = document.getElementById("pass").value;

  // Envia as credenciais e valida a resposta antes de guardar o grupo na sessao local.
  try {
    const resposta = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user, pass })
    });
    const data = await resposta.json();

    console.log("Resposta do servidor:", data);

    if (data.success && data.userGP) {
      sessionStorage.setItem("userGP", data.userGP);
      window.location.href = "../Estoque/estoque.html";
    } else {
      alert("Usuário ou senha incorretos.");
    }
  } catch (error) {
    console.error("Não foi possível concluir o login:", error);
    alert("Não foi possível conectar ao servidor. Tente novamente.");
  }
}