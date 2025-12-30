# Finance AI 🧠💰

**Finance AI** é uma plataforma completa de gestão financeira pessoal que utiliza Inteligência Artificial de ponta para transformar a maneira como você lida com seu dinheiro. Esqueça as planilhas complexas; o Finance AI oferece uma interface intuitiva e um assistente inteligente baseado no modelo **Llama 3.1 70B via Groq** para fornecer insights em tempo real.

---

## 🌟 O que é o Finance AI?

O Finance AI não é apenas um rastreador de despesas. É um ecossistema financeiro projetado para dar clareza e controle total sobre sua vida financeira. Ele combina o armazenamento seguro de dados locais com o poder de processamento de linguagem natural ultra-rápido da infraestrutura Groq.

### Principais Diferenciais:
- **Velocidade Groq**: Respostas da IA quase instantâneas graças à tecnologia LPU da Groq.
- **Privacidade**: Seus dados financeiros são armazenados localmente em um banco de dados SQLite.
- **Simplicidade**: Interface limpa, focada no que importa: seu saldo e sua saúde financeira.

---

## 🚀 Funcionalidades Completas

### 📊 Dashboard de Controle
- **Visão Geral**: Saldo total consolidado, somando todas as suas contas.
- **Fluxo de Caixa**: Monitoramento em tempo real de entradas (receitas) e saídas (despesas).
- **Navegação Temporal**: Filtre seus dados por mês e ano para analisar seu histórico.

### 🏦 Gestão de Contas e Bancos
- **Múltiplas Contas**: Cadastre contas de diferentes bancos (Corrente, Poupança, Investimentos).
- **Saldos Individuais**: Acompanhe quanto você tem em cada instituição separadamente.

### 📝 Lançamentos Inteligentes
- **Categorização**: Organize seus gastos por categorias (Alimentação, Lazer, Transporte, etc.).
- **Interface Rápida**: Formulário otimizado para lançamentos em segundos, seja no desktop ou celular.

### 🤖 Assistente Financeiro IA (Groq)
O coração do projeto. O assistente tem acesso ao seu contexto financeiro (respeitando a privacidade) e pode:
- **Analisar Gastos**: *"Onde gastei mais este mês?"*
- **Dar Conselhos**: *"Como posso economizar para uma viagem de R$ 5.000?"*
- **Prever Tendências**: *"Baseado no meu histórico, quanto terei na conta no fim do mês?"*
- **Responder Dúvidas**: *"Qual a diferença entre CDI e Poupança?"*

---

## 🛠️ Arquitetura Técnica

### Frontend (Web)
- **TailwindCSS**: Estilização moderna e responsiva.
- **Chart.js**: Gráficos dinâmicos para visualização de tendências.
- **Marked.js**: Para que as respostas da IA sejam ricas e bem formatadas.
- **FontAwesome**: Iconografia intuitiva.

### Backend (Core)
- **Python**: Linguagem base para o processamento e API.
- **SQLite**: Banco de dados relacional leve, armazenado em `./backend/data/finance.db`.
- **Groq SDK**: Integração com o modelo `llama-3.1-70b-versatile`.

---

## 📂 Estrutura de Pastas

```text
financeai/
├─ web/
│  ├─ index.html          # O coração da interface
│  └─ assets/
│     └─ logo.png         # Identidade visual única
│
├─ backend/
│  ├─ server.py           # API e lógica de integração com Groq
│  ├─ requirements.txt    # Dependências (Flask/FastAPI, Groq, etc.)
│  ├─ .env                # Suas chaves secretas
│  ├─ .env.example        # Modelo para novos usuários
│  └─ data/
│     └─ finance.db       # Onde seu dinheiro é organizado
│
└─ README.md              # Esta documentação
```

---

## ⚙️ Como Começar

### 1. Prepare o Ambiente
Certifique-se de ter o Python instalado. Clone o projeto e instale as dependências:
```bash
cd backend
pip install -r requirements.txt
```

### 2. Configure suas Chaves
Renomeie o arquivo `.env.example` para `.env` e adicione sua chave do Groq:
```env
GROQ_API_KEY=gsk_sua_chave_aqui
GROQ_MODEL=llama-3.1-70b-versatile
FINANCE_DB=./data/finance.db
```

### 3. Rode o Projeto
Inicie o backend:
```bash
python server.py
```
E abra o `web/index.html` no seu navegador favorito.

