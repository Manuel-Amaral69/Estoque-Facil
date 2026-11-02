// ================= IMPORTAÇÃO DE BIBLIOTECAS =================
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const cors = require("cors");

// ================= CONFIGURAÇÃO DO SERVIDOR =================
const app = express();
 
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(__dirname + "/Login/login.html");
});

// Habilita CORS para permitir requisições externas
app.use(cors());

// Permite o uso de JSON no corpo das requisições
app.use(bodyParser.json());

// ================= CONFIGURAÇÃO DO BANCO DE DADOS =================

// Cria ou conecta ao banco SQLite
const db = new sqlite3.Database("./database.db");

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
        return res.json({ success: true, userGP: row.group_id });
      }

      // Caso não encontre usuário válido
      return res.json({ success: false });
    }
  );
});

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

// ================= ROTAS DE HISTÓRICO DE VENDAS =================
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

      res.json({ success: true });
    }
  );
});

// ================= INICIALIZAÇÃO DO SERVIDOR =================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor em execução na porta ${PORT}`);
});