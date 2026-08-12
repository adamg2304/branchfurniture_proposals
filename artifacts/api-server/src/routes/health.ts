import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function ok(_req: Request, res: Response) {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

// The deployment supervisor probes BOTH the configured startup path
// (/api/healthz) and the service root path (/api, from `paths`/`previewPath`
// in artifact.toml). If GET /api has no handler it falls through to a 404
// (surfaced as a 500 through Replit's ingress proxy), which the platform reads
// as an unhealthy service and SIGTERMs the process — a crash loop. Answer the
// root path with the same 200 so every probe the supervisor makes succeeds.
router.get("/", ok);
router.get("/healthz", ok);

export default router;
