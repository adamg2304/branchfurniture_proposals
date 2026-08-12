import { Router, type IRouter } from "express";
import healthRouter from "./health";
import quoteRouter from "./quote";
import acceptRouter from "./accept";
import dealRouter from "./deal";
import provisionRouter from "./provision";

const router: IRouter = Router();

router.use(healthRouter);
router.use(quoteRouter);
router.use(acceptRouter);
router.use(dealRouter);
router.use(provisionRouter);

export default router;
