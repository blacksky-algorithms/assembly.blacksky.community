# Blacksky People's Assembly

A platform for public deliberation and collective decision-making. Community members vote on statements, and the system uses clustering and visualization to map where people agree and disagree.

This is a fork of [Polis](https://github.com/compdemocracy/polis) by [The Computational Democracy Project](https://compdemocracy.org). For general Polis documentation, setup guides, and the methods paper, see the upstream repo.

## How this fork differs

- **atproto identity** — Participants sign in with their [AT Protocol](https://atproto.com) handle (e.g. from Bluesky). Votes and statements are optionally published as signed records in the participant's repo.
- **Delphi analysis pipeline** — Replaces the legacy Clojure math service with a Python pipeline using sentence embeddings (all-MiniLM-L6-v2), UMAP, HDBSCAN, and local LLM narrative generation via Ollama.
- **Participation client** — An Astro 5 + React client (`client-participation-alpha/`) replaces the legacy Backbone client for the voting interface.
- **Embeddable voting** — Conversations can be embedded as interactive voting cards in other applications (e.g. the [blacksky.community](https://blacksky.community) social client).
- **Badge system** — Participant identity cards show community roles (Member, Funder, Team, OSS Supporter) sourced from external data.
- **Email notifications** — SMTP transport (e.g. Resend) for participant notification emails when new statements arrive.

---

## Running locally

Prerequisite: a recent version of Docker (with `docker compose`).

```sh
cp example.env .env
make start
```

Visit `http://localhost:80/home`. Log in with the test account `admin@polis.test` / `Te$tP@ssw0rd*`.

See the [upstream Polis README](https://github.com/compdemocracy/polis#-running-polis) for detailed Docker setup, production deployment, SSL, scaling, and troubleshooting.

### Key commands

```sh
make start                # Start all services (dev mode)
make start-rebuild        # Rebuild containers and start
make PROD start           # Start with prod.env (no dev overlay)
make rebuild-web          # Rebuild only the web clients
make stop                 # Stop all services
make start-FULL-REBUILD   # Nuclear option: wipe volumes and rebuild everything
```

### Using a non-Docker database

Set `POSTGRES_DOCKER=false` in `.env` and provide your own `DATABASE_URL`. Omit `--profile postgres` from any manual `docker compose` commands.

### Development overlay

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile postgres --profile local-services up --build
```

Enables live code reloading for the server, nREPL for the math service, direct database port access, and other dev conveniences.

### Testing

End-to-end tests use Cypress. See [`e2e/README.md`](/e2e/README.md).

### Database migrations

Migration files live in `server/postgres/migrations/`. See [docs/migrations.md](docs/migrations.md).

---

## 🤖 AI Transparency

This project uses AI and machine learning in several places. Here is a complete accounting of what models are used, what they do, and whether they are on by default.

| Module | Model | What is it? | Purpose | Environment | On/Off |
|---|---|---|---|---|---|
| Opinion grouping | PCA + K-means | Classical statistics — finds patterns in how people vote by reducing data to its most important dimensions, then grouping similar voters together | Groups participants who vote similarly into opinion clusters | Self-hosted | On |
| Comment embeddings | all-MiniLM-L6-v2 | A small neural network that converts text into numbers (vectors) so that similar sentences are "close" in math space | Understands what comments mean so similar ideas can be grouped into topics | Self-hosted | On |
| Topic discovery | UMAP + HDBSCAN | Unsupervised machine learning — UMAP compresses high-dimensional data into a 2D map, HDBSCAN finds natural clusters within it. Neither needs labeled training data | Automatically finds topics by grouping related comments together | Self-hosted | On |
| Topic descriptions | Ollama (Llama 3.1 8B) | A large language model (LLM) running locally — generates human-readable text based on patterns learned from training data | Writes short labels and summaries for discovered topics | Self-hosted | On |
| Report narratives | Claude / Gemini / GPT-4 (swappable) | Cloud-hosted LLMs — same technology as ChatGPT, used to read and summarize structured data into prose | Generates a written summary of the conversation — what groups think, where there's consensus and disagreement | Cloud API | Off |
| Collective statements | Claude | Cloud-hosted LLM — synthesizes multiple inputs into a single coherent output | Combines highly-agreed-upon comments into a statement representing what most people think | Cloud API | Off |
| Content moderation | Gemini 2.5 Pro | Cloud-hosted LLM evaluating text against a rubric — like an automated reviewer following written guidelines | Reviews submitted statements for inappropriate content before they enter the conversation | Cloud API | Off |
| Spam detection | Akismet | A cloud service that uses statistical models trained on millions of spam samples to classify content as spam or not | Catches spam submissions | Cloud API | Off |
| Language detection | Google Cloud Translation | A cloud service that identifies which language text is written in using statistical patterns | Detects what language a statement was written in | Cloud API | Off |
| Translation | Google Cloud Translation | Neural machine translation — translates text between languages using a trained model | Translates statements so participants can read contributions in other languages | Cloud API | Off |

**"Self-hosted"** means the model runs entirely on your own infrastructure — no data leaves your servers. **"Cloud API"** means data is sent to a third-party service for processing. All cloud-based modules are **off by default** and require you to provide your own API key to enable.

---

## License

[AGPLv3 with additional permission under section 7](/LICENSE)
