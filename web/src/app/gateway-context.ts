import { createContext, useContext } from "react";
import type { Gateway } from "../platform";

export const GatewayContext = createContext<Gateway | null>(null);
export const useGateway = () => useContext(GatewayContext);
