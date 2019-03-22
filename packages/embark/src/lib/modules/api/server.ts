import bodyParser from "body-parser";
import cors from "cors";
import { Embark, Plugins } from "embark";
import express, { NextFunction, Request, Response } from "express";
import proxy from "express-http-proxy";
import expressWs from "express-ws";
import findUp from "find-up";
import helmet from "helmet";
import * as http from "http";
import {__} from "i18n";
import * as path from "path";
import * as ws from "ws";
// @ts-ignore
import { embarkPath, existsSync } from "../../core/fs";

type Method = "get" | "post" | "ws" | "delete";

interface CallDescription {
  method: Method;
  endpoint: string;
  cb(req: Request | ws, res: Response | Request): void;
}

export default class Server {
  private isLogging: boolean = false;
  private expressInstance: expressWs.Instance;
  private server?: http.Server;

  constructor(private embark: Embark, private port: number, private hostname: string, private plugins: Plugins) {
    this.expressInstance = this.initApp();
  }

  public enableLogging() {
    this.isLogging = true;
  }

  public disableLogging() {
    this.isLogging = false;
  }

  public start() {
    return new Promise<void>((resolve, reject) => {
      if (this.server) {
        const message = __("API is already running");
        return reject(new Error(message));
      }

      this.server = this.expressInstance.app.listen(this.port, this.hostname, () => {
        resolve();
      });
    });
  }

  public stop() {
    return new Promise<void>((resolve, reject) => {
      if (!this.server) {
        const message = __("API is not running");
        return reject(new Error(message));
      }

      this.server.close(() => {
        this.server = undefined;
        resolve();
      });
    });
  }

  private initApp() {
    const instance = expressWs(express());
    instance.app.use((req: Request, res: Response, next: NextFunction) => {
      if (!this.isLogging) {
        return next();
      }

      if (!req.headers.upgrade) {
        this.embark.logger.info(`API > ${req.method} ${req.originalUrl}`);
      }
      next();
    });

    instance.app.use(helmet.noCache());
    instance.app.use(cors());

    instance.app.use(bodyParser.json());
    instance.app.use(bodyParser.urlencoded({extended: true}));

    instance.app.ws("/logs", (websocket: ws, _req: Request) => {
      this.embark.events.on("log", (level: string, message: string) => {
        websocket.send(JSON.stringify({msg: message, msg_clear: message.stripColors, logLevel: level}), () => {});
      });
    });

    if (this.plugins) {
      instance.app.get("/embark-api/plugins", (req: Request, res: Response) => {
        res.send(JSON.stringify(this.plugins.plugins.map((plugin) => ({name: plugin.name}))));
      });

      const callDescriptions: CallDescription[] = this.plugins.getPluginsProperty("apiCalls", "apiCalls");
      callDescriptions.forEach((callDescription) => this.registerCallDescription(instance, callDescription));
    }

    this.embark.events.on("plugins:register:api", (callDescription: CallDescription) => this.registerCallDescription(instance, callDescription));

    let monorepoRootDir = "";
    const isInsideMonorepo = existsSync(path.join(embarkPath(), "../../packages/embark"));
    if (isInsideMonorepo) {
      monorepoRootDir = path.resolve(path.join(embarkPath(), "../.."));
    }
    const buildDir = findUp.sync("node_modules/embark-ui/build", {cwd: embarkPath()}) ||
      embarkPath("node_modules/embark-ui/build");

    if (!isInsideMonorepo || process.env.EMBARK_UI_STATIC) {
      if (existsSync(path.join(buildDir, "index.html"))) {
        instance.app.use("/", express.static(buildDir));
        instance.app.get("/*", (_req, res) => {
          res.sendFile(path.join(buildDir, "index.html"));
        });
      } else {
        let envReport = "";
        let inside = `in <code>${path.dirname(buildDir)}</code>`;
        let notice = "<p>this distribution of <code>embark-ui</code> appears to be broken</p>";
        if (isInsideMonorepo) {
          envReport = `<p><code>process.env.EMBARK_UI_STATIC=${process.env.EMBARK_UI_STATIC}</code></p>`;
          inside = `inside the monorepo at <code>${path.join(monorepoRootDir, "packages/embark-ui")}</code>`;
          notice = `
            <p>to build <code>embark-ui</code> please run either:</p>
            <p><code>cd ${monorepoRootDir} && yarn build</code><br />
              or<br />
              <code>cd ${path.join(monorepoRootDir, "packages/embark-ui")}
                && yarn build</code></p>
            <p>restart <code>embark run</code> after building <code>embark-ui</code></p>
          `;
        }
        const page = (reloadSec: number) => (`
          <!doctype html>
          <html lang="en">
            <head>
              <meta charset="utf-8" />
              ${isInsideMonorepo ? `<meta http-equiv="refresh" content="${reloadSec}">` : ""}
              <title>Embark API Server</title>
              <style type="text/css">
                code {
                  background-color: rgba(220,220,220,.5);
                }
              </style>
            </head>
            <body>
              ${envReport}
              <p>missing build for package <code>embark-ui</code> ${inside}</p>
              ${notice}
              ${isInsideMonorepo ? `
                <p>this page will automatically reload
                  <span id="time-left">
                    in ${reloadSec} second${reloadSec !== 1 ? "s" : ""}
                  </span></p>
                <script>
                  let timeLeft = ${reloadSec};
                  const span = document.querySelector("#time-left");
                  setInterval(() => {
                    if (timeLeft >= 1) { timeLeft -= 1; }
                    if (!timeLeft) { return span.innerText = "now"; }
                    span.innerText = \`in \${timeLeft} second\${timeLeft !== 1 ? "s" : ""}\`;
                  }, 1000);
                </script>
              ` : ""}
            </body>
          </html>
        `.trim().split("\n").map((str) => str.trim()).filter((str) => str).join("\n"));
        const page404 = page(3);
        const missingBuildHandler = (_req: Request, res: Response) => {
          res.status(404).send(page404);
        };
        instance.app.get("/", missingBuildHandler);
        instance.app.get("/*", missingBuildHandler);
      }
    } else {
      const pageEConnError = (waitingFor: string, reloadSec: number) => (`
        <!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta http-equiv="refresh" content="${reloadSec}">
            <title>Embark API Server</title>
            <style type="text/css">
              code {
                background-color: rgba(220,220,220,.5);
              }
            </style>
          </head>
          <body>
            <p><code>lib/modules/api/server</code> inside the monorepo at
              <code>${path.join(monorepoRootDir, "embark")}</code> is waiting
              for the Create React App development server of package
              <code>embark-ui</code> to ${waitingFor} at
              <code>localhost:55555</code></p>
            ${waitingFor === "become available" ? `
              <p>please run either:</p>
              <p><code>cd ${monorepoRootDir} && yarn start</code><br />
                or<br />
                <code>cd ${path.join(monorepoRootDir, "packages/embark-ui")}
                  && yarn start</code></p>
              <p>to instead use a static build from the monorepo, restart embark
                with: <code>EMBARK_UI_STATIC=t embark run</code></p>
            ` : ""}
            <p>this page will automatically reload
               <span id="time-left">
                 in ${reloadSec} second${reloadSec !== 1 ? "s" : ""}
               </span></p>
            <script>
              let timeLeft = ${reloadSec};
              const span = document.querySelector("#time-left");
              setInterval(() => {
                if (timeLeft >= 1) { timeLeft -= 1; }
                if (!timeLeft) { return span.innerText = "now"; }
                span.innerText = \`in \${timeLeft} second\${timeLeft !== 1 ? "s" : ""}\`;
              }, 1000);
            </script>
          </body>
        </html>
      `.trim().split("\n").map((str) => str.trim()).filter((str) => str).join("\n"));
      const pageEconnRefused = pageEConnError("become available", 3);
      const pageEconnReset = pageEConnError("become responsive", 3);
      instance.app.use("/", proxy("http://localhost:3000", {
        // @ts-ignore
        proxyErrorHandler: (err, res, next) => {
          switch (err && err.code) {
            case "ECONNREFUSED": {
              return res.status(503).send(pageEconnRefused);
            }
            case "ECONNRESET": {
              if (err.message === "socket hang up") {
                return res.status(504).send(pageEconnReset);
              }
            }
            default: { next(err); }
          }
        },
        timeout: 1000,
      }));
    }

    return instance;
  }

  private registerCallDescription(instance: expressWs.Instance, callDescription: CallDescription) {
    if (callDescription.method === "ws") {
      instance.app.ws(callDescription.endpoint, this.applyWSFunction.bind(this, callDescription.cb));
    } else {
      instance.app[callDescription.method].apply(instance.app, [callDescription.endpoint, this.applyHTTPFunction.bind(this, callDescription.cb)]);
    }
  }

  private applyHTTPFunction(cb: (req: Request, res: Response) => void, req: Request, res: Response) {
    this.embark.events.request("authenticator:authorize", req, res, (err: Error) => {
      if (err) {
        return res.send(err);
      }
      cb(req, res);
    });
  }

  private applyWSFunction(cb: (ws: ws, req: Request) => void, websocket: ws, req: Request) {
    this.embark.events.request("authenticator:authorize", websocket, req, (err: Error) => {
      if (!err) {
        cb(websocket, req);
      }
    });
  }
}
