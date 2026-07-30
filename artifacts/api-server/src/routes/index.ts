import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoteRouter from "./quote";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quoteRouter);

export default router;
