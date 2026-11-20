// ================= IMPORTAÇÃO DE BIBLIOTECAS =================
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const webpush = require("web-push");

// ================= CONFIGURAÇÃO DO SERVIDOR =================
const app = express();
const publicDirectory = path.join(__dirname, "public");

// Publica somente os arquivos do frontend, sem expor o banco ou o codigo do servidor.
app.use(express.static(publicDirectory));

// Disponibiliza apenas o bundle usado pelo leitor de codigo de barras.
app.get("/vendor/html5-qrcode/html5-qrcode.min.js", (req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "html5-qrcode", "html5-qrcode.min.js"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(publicDirectory, "Login", "login.html"));
});

// Habilita CORS para permitir requisições externas
app.use(cors());
app.use(cookieParser());

// Permite o uso de JSON no corpo das requisições
app.use(bodyParser.json());

// ================= CONFIGURAÇÃO DO BANCO DE DADOS =================

// Cria ou conecta ao banco SQLite
const db = new sqlite3.Database(path.join(__dirname, "database.db"));
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";
const pushConfigured = Boolean(vapidPublicKey && vapidPrivateKey);

if (pushConfigured) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:admin@example.com",
    vapidPublicKey,
    vapidPrivateKey
  );
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function encryptSubscription(subscription) {
  const keySource = process.env.PUSH_ENCRYPTION_KEY || vapidPrivateKey;
  if (!keySource) throw new Error("Configure PUSH_ENCRYPTION_KEY ou as chaves VAPID.");
  const key = crypto.createHash("sha256").update(keySource).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(subscription)), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), encrypted.toString("base64")].join(".");
}

function decryptSubscription(payload) {
  const keySource = process.env.PUSH_ENCRYPTION_KEY || vapidPrivateKey;
  const [ivHex, tagHex, ciphertext] = payload.split(".");
  const key = crypto.createHash("sha256").update(keySource).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8"));
}

// Garante execução sequencial das operações
db.serialize(() => {

  // ================= CRIAÇÃO DA TABELA DE USUÁRIOS =================
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      pass TEXT,
      group_id INTEGER
    )
  `);

  // ================= CRIAÇÃO DA TABELA DE ESTOQUE =================
  db.run(`
    CREATE TABLE IF NOT EXISTS estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_produto TEXT,
      quantidade INTEGER,
      codigo_barras TEXT,
      valor_compra REAL,
      valor_venda REAL,
      min_stock INTEGER,
      group_id INTEGER,
      UNIQUE(nome_produto, group_id)
);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      total REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS venda_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venda_id INTEGER NOT NULL,
      produto_id INTEGER,
      nome_produto TEXT NOT NULL,
      quantidade INTEGER NOT NULL,
      valor_unitario REAL NOT NULL,
      subtotal REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      group_id INTEGER NOT NULL,
      endpoint_hash TEXT NOT NULL UNIQUE,
      encrypted_subscription TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS product_alert_state (
      product_id INTEGER PRIMARY KEY,
      condition TEXT NOT NULL DEFAULT 'healthy'
    )
  `);

  // ================= INSERÇÃO DE USUÁRIO PADRÃO =================
  db.run(`
    INSERT OR IGNORE INTO users (id, user, pass, group_id)
    VALUES (1, 'admin', '123', 1)
  `);
});

// ================= ROTA DE LOGIN =================
app.post("/login", (req, res) => {

  // Obtém os dados enviados pelo cliente
  const { user, pass } = req.body;

  // Realiza consulta para validar credenciais
  db.get(
    "SELECT * FROM users WHERE user = ? AND pass = ?",
    [user, pass],
    (err, row) => {

      // Tratamento de erro
      if (err) {
        console.error("Erro ao consultar usuário:", err);
        return res.json({ success: false });
      }

      // Retorna sucesso e o grupo do usuário, caso encontrado
      if (row) {
        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
        db.run("DELETE FROM auth_sessions WHERE expires_at <= ?", [new Date().toISOString()]);
        return db.run(
          "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
          [hashToken(token), row.id, expiresAt],
          (sessionError) => {
            if (sessionError) {
              console.error("Erro ao criar sessão:", sessionError);
              return res.status(500).json({ success: false });
            }
            res.cookie("estoque_session", token, {
              httpOnly: true,
              secure: process.env.NODE_ENV === "production",
              sameSite: "lax",
              maxAge: 30 * 24 * 60 * 60 * 1000,
              path: "/"
            });
            return res.json({ success: true, userGP: row.group_id });
          }
        );
      }

      // Caso não encontre usuário válido
      return res.json({ success: false });
    }
  );
});

// ================= AUTENTICACAO E INSCRICOES PUSH =================
function requirePushAuth(req, res, next) {
  const token = req.cookies.estoque_session;
  if (!token) return res.status(401).json({ success: false });

  db.get(
    `SELECT u.id AS user_id, u.group_id
     FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    [hashToken(token), new Date().toISOString()],
    (err, session) => {
      if (err || !session) return res.status(401).json({ success: false });
      req.pushUser = session;
      next();
    }
  );
}

// Envia um alerta apenas quando o produto muda para outra condicao de estoque.
function evaluateGroupStock(groupId) {
  if (!pushConfigured) return;
  db.all("SELECT * FROM estoque WHERE group_id = ?", [groupId], (stockError, products) => {
    if (stockError || !products?.length) return;
    db.all(
      `SELECT p.id, p.encrypted_subscription
       FROM push_subscriptions p JOIN users u ON u.id = p.user_id
       WHERE p.group_id = ? AND u.group_id = ?`,
      [groupId, groupId],
      (subError, subscriptions) => {
      if (subError || !subscriptions?.length) return;

      products.forEach((product) => {
        const condition = product.quantidade <= 0
          ? "out"
          : product.quantidade <= (Number(product.min_stock) || 0) ? "low" : "healthy";

        db.run(
          "INSERT OR IGNORE INTO product_alert_state (product_id, condition) VALUES (?, 'healthy')",
          [product.id],
          (insertError) => {
            if (insertError) return console.error("Erro ao preparar estado do alerta:", insertError);
            db.run(
              "UPDATE product_alert_state SET condition = ? WHERE product_id = ? AND condition != ?",
              [condition, product.id, condition],
              function (updateError) {
                if (updateError || this.changes !== 1 || condition === "healthy") return;
                const title = condition === "out" ? "Produto sem estoque" : "Estoque mínimo atingido";
                const body = `${product.nome_produto}: quantidade atual ${product.quantidade}.`;
                const message = JSON.stringify({
                  title,
                  body,
                  url: "/Estoque/estoque.html",
                  tag: `estoque-${product.id}-${condition}`,
                  productId: product.id,
                  quantity: product.quantidade
                });

                subscriptions.forEach((row) => {
                  let subscription;
                  try {
                    subscription = decryptSubscription(row.encrypted_subscription);
                  } catch (decryptError) {
                    console.error("Não foi possível descriptografar inscrição push:", decryptError);
                    return;
                  }
                  webpush.sendNotification(subscription, message).catch((pushError) => {
                    if (pushError.statusCode === 404 || pushError.statusCode === 410) {
                      db.run("DELETE FROM push_subscriptions WHERE id = ?", [row.id]);
                    } else {
                      console.error("Falha ao enviar notificação push:", pushError.message);
                    }
                  });
                });
              }
            );
          }
        );
      });
      }
    );
  });
}

app.get("/api/push/public-key", (req, res) => {
  if (!pushConfigured) return res.status(503).json({ success: false, error: "Push não configurado." });
  res.json({ success: true, publicKey: vapidPublicKey });
});

app.get("/api/push/subscription", requirePushAuth, (req, res) => {
  const endpoint = req.query.endpoint;
  if (!endpoint) return res.json({ success: true, enabled: false });
  db.get(
    "SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?",
    [req.pushUser.user_id, hashToken(endpoint)],
    (err, row) => {
      if (err) return res.status(500).json({ success: false });
      res.json({ success: true, enabled: Boolean(row) });
    }
  );
});

app.post("/api/push/subscription", requirePushAuth, (req, res) => {
  if (!pushConfigured) return res.status(503).json({ success: false, error: "Push não configurado." });
  const subscription = req.body?.subscription;
  if (!subscription?.endpoint?.startsWith("https://") || !subscription.keys?.p256dh || !subscription.keys?.auth) {
    return res.status(400).json({ success: false, error: "Inscrição push inválida." });
  }

  let encrypted;
  try {
    encrypted = encryptSubscription(subscription);
  } catch (error) {
    return res.status(503).json({ success: false, error: error.message });
  }
  const endpointHash = hashToken(subscription.endpoint);
  db.run(
    `INSERT INTO push_subscriptions (user_id, group_id, endpoint_hash, encrypted_subscription)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint_hash) DO UPDATE SET user_id = excluded.user_id,
       group_id = excluded.group_id, encrypted_subscription = excluded.encrypted_subscription`,
    [req.pushUser.user_id, req.pushUser.group_id, endpointHash, encrypted],
    (err) => {
      if (err) return res.status(500).json({ success: false });
      evaluateGroupStock(req.pushUser.group_id);
      res.json({ success: true });
    }
  );
});

app.delete("/api/push/subscription", requirePushAuth, (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ success: false });
  db.run(
    "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?",
    [req.pushUser.user_id, hashToken(endpoint)],
    (err) => err ? res.status(500).json({ success: false }) : res.json({ success: true })
  );
});

app.post("/api/logout", requirePushAuth, (req, res) => {
  const token = req.cookies.estoque_session;
  db.run("DELETE FROM auth_sessions WHERE token_hash = ?", [hashToken(token)], (err) => {
    if (err) return res.status(500).json({ success: false });
    res.clearCookie("estoque_session", { httpOnly: true, sameSite: "lax", path: "/" });
    res.json({ success: true });
  });
});

// ================= ROTAS DE ESTOQUE =================
// ================= ROTA PARA BUSCAR ESTOQUE =================
app.get("/estoque/:userGP", (req, res) => {

  // Obtém o identificador do grupo pela URL
  const userGP = req.params.userGP;

  // Consulta produtos pertencentes ao grupo
  db.all(
    "SELECT * FROM estoque WHERE group_id = ?",
    [userGP],
    (err, rows) => {

      // Tratamento de erro
      if (err) {
        console.error("Erro ao buscar estoque:", err);
        return res.json([]);
      }

      // Retorna lista de produtos
      return res.json(rows);
    }
  );
});

// ================= ROTAS DE HISTORICO DE VENDAS =================
app.get("/vendas/:userGP", (req, res) => {
  db.all(
    `SELECT v.id, v.created_at, v.total, vi.produto_id, vi.nome_produto,
            vi.quantidade, vi.valor_unitario, vi.subtotal
     FROM vendas v
     LEFT JOIN venda_itens vi ON vi.venda_id = v.id
     WHERE v.group_id = ?
     ORDER BY v.id DESC, vi.id ASC`,
    [req.params.userGP],
    (err, rows) => {
      if (err) {
        console.error("Erro ao buscar histórico de vendas:", err);
        return res.status(500).json({ success: false });
      }

      return res.json(rows);
    }
  );
});

app.post("/vendas", (req, res) => {
  const { userGP, itens } = req.body;
  if (!userGP || !Array.isArray(itens) || itens.length === 0) {
    return res.status(400).json({ success: false, error: "Venda inválida." });
  }

  db.serialize(() => {
    db.run("BEGIN IMMEDIATE", (beginError) => {
      if (beginError) {
        console.error("Erro ao iniciar venda:", beginError);
        return res.status(500).json({ success: false });
      }

      const itensVenda = [];
      let total = 0;
      let indice = 0;

      const cancelarVenda = (error, status = 400) => {
        console.error("Venda não concluída:", error);
        db.run("ROLLBACK", () => {
          if (!res.headersSent) res.status(status).json({ success: false });
        });
      };

      const processarProximoItem = () => {
        if (indice >= itens.length) {
          db.run(
            "INSERT INTO vendas (group_id, total) VALUES (?, ?)",
            [userGP, total],
            function (insertError) {
              if (insertError) return cancelarVenda(insertError, 500);
              const vendaId = this.lastID;
              let itemIndice = 0;

              const salvarProximoItem = () => {
                if (itemIndice >= itensVenda.length) {
                  return db.run("COMMIT", (commitError) => {
                    if (commitError) return cancelarVenda(commitError, 500);
                    evaluateGroupStock(userGP);
                    res.json({ success: true, vendaId, total });
                  });
                }

                const item = itensVenda[itemIndice++];
                db.run(
                  `INSERT INTO venda_itens
                   (venda_id, produto_id, nome_produto, quantidade, valor_unitario, subtotal)
                   VALUES (?, ?, ?, ?, ?, ?)`,
                  [vendaId, item.produto_id, item.nome_produto, item.quantidade, item.valor_unitario, item.subtotal],
                  (itemError) => itemError ? cancelarVenda(itemError, 500) : salvarProximoItem()
                );
              };

              salvarProximoItem();
            }
          );
          return;
        }

        const entrada = itens[indice++];
        const quantidade = Number(entrada.quantidade);
        if (!Number.isInteger(quantidade) || quantidade < 1) {
          return cancelarVenda(new Error("Quantidade inválida."));
        }

        db.get(
          "SELECT * FROM estoque WHERE id = ? AND group_id = ?",
          [entrada.id, userGP],
          (lookupError, produto) => {
            if (lookupError) return cancelarVenda(lookupError, 500);
            if (!produto || quantidade > produto.quantidade) {
              return cancelarVenda(new Error("Produto inexistente ou estoque insuficiente."));
            }

            const valorUnitario = Number(produto.valor_venda) || 0;
            const subtotal = valorUnitario * quantidade;
            db.run(
              "UPDATE estoque SET quantidade = quantidade - ? WHERE id = ? AND group_id = ? AND quantidade >= ?",
              [quantidade, produto.id, userGP, quantidade],
              function (updateError) {
                if (updateError) return cancelarVenda(updateError, 500);
                if (this.changes !== 1) return cancelarVenda(new Error("Estoque insuficiente."));

                itensVenda.push({
                  produto_id: produto.id,
                  nome_produto: produto.nome_produto,
                  quantidade,
                  valor_unitario: valorUnitario,
                  subtotal
                });
                total += subtotal;
                processarProximoItem();
              }
            );
          }
        );
      };

      processarProximoItem();
    });
  });
});

// ================= ROTA PARA ADICIONAR PRODUTO =================
app.post("/estoque", (req, res) => {

  const { 
    nome, 
    quantidade, 
    userGP, 
    codigo_barras, 
    valor_compra, 
    valor_venda,
    min_stock
  } = req.body;

  console.log("Dados recebidos:", req.body);

  db.get(
    "SELECT * FROM estoque WHERE nome_produto = ? AND group_id = ?",
    [nome, userGP],
    (err, row) => {

      if (err) {
        console.error(err);
        return res.json({ success: false });
      }

      if (row) {
        const novaQuantidade = row.quantidade + Number(quantidade);

        db.run(
          `UPDATE estoque 
           SET quantidade = ?, 
               codigo_barras = ?, 
               valor_compra = ?, 
               valor_venda = ?,
               min_stock = ?
           WHERE id = ?`,
          [novaQuantidade, codigo_barras, valor_compra, valor_venda, min_stock, row.id],
          (err) => {
            if (err) {
              console.error(err);
              return res.json({ success: false });
            }

            evaluateGroupStock(userGP);
            return res.json({ success: true, updated: true });
          }
        );

      } else {

        db.run(
          `INSERT INTO estoque 
           (nome_produto, quantidade, codigo_barras, valor_compra, valor_venda, min_stock, group_id) 
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [nome, quantidade, codigo_barras, valor_compra, valor_venda, min_stock, userGP],
          (err) => {

            if (err) {
              console.error(err);
              return res.json({ success: false });
            }

            evaluateGroupStock(userGP);
            return res.json({ success: true, created: true });
          }
        );
      }
    }
  );
});

// ================= ROTA PARA REMOVER PRODUTO =================
app.delete("/estoque/:id", (req, res) => {
  const id = req.params.id;

  db.run("DELETE FROM estoque WHERE id = ?", [id], (err) => {
    if (err) {
      console.error(err);
      return res.json({ success: false });
    }

    db.run("DELETE FROM product_alert_state WHERE product_id = ?", [id]);
    res.json({ success: true });
  });
});

// ================= EDITAR PRODUTO =================
app.put("/estoque/:id", (req, res) => {
  const id = req.params.id;

  const {
    nome,
    quantidade,
    codigo_barras,
    valor_compra,
    valor_venda,
    min_stock
  } = req.body;

  db.run(
    `UPDATE estoque 
     SET nome_produto = ?, 
         quantidade = ?, 
         codigo_barras = ?, 
         valor_compra = ?, 
         valor_venda = ?,
         min_stock = ?
     WHERE id = ?`,
    [nome, quantidade, codigo_barras, valor_compra, valor_venda, min_stock, id],
    (err) => {
      if (err) {
        console.error(err);
        return res.json({ success: false });
      }

      db.get("SELECT group_id FROM estoque WHERE id = ?", [id], (lookupError, product) => {
        if (!lookupError && product) evaluateGroupStock(product.group_id);
      });
      res.json({ success: true });
    }
  );
});

// ================= INICIALIZAÇÃO DO SERVIDOR =================
const PORT = process.env.PORT || 3000;

db.all("SELECT DISTINCT group_id FROM push_subscriptions", (err, groups) => {
  if (!err) groups.forEach((group) => evaluateGroupStock(group.group_id));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor em execução na porta ${PORT}`);
});