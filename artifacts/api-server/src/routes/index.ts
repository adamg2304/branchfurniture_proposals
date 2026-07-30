import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoteRouter from "./quote";
import acceptRouter from "./accept";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quoteRouter);
router.use(acceptRouter);

export default router;
