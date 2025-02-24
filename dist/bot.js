"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const web3_js_1 = require("@solana/web3.js");
const sdk_1 = require("@orca-so/sdk");
const decimal_js_1 = require("decimal.js");
const bs58_1 = __importDefault(require("bs58"));
const dotenv = __importStar(require("dotenv"));
// Load environment variables
dotenv.config();
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const decodedKey = bs58_1.default.decode(PRIVATE_KEY);
// Configure connection and wallet
const connection = new web3_js_1.Connection(RPC_URL, "confirmed");
const wallet = web3_js_1.Keypair.fromSecretKey(Uint8Array.from(decodedKey));
// Initialize Orca SDK
const orca = (0, sdk_1.getOrca)(connection);
const calculateProfit = (startAmount, rate1, rate2, rate3, fee) => {
    const afterFirstSwap = startAmount.mul(rate1).mul(decimal_js_1.Decimal.sub(1, fee)); // Token A -> Token B
    const afterSecondSwap = afterFirstSwap.mul(rate2).mul(decimal_js_1.Decimal.sub(1, fee)); // Token B -> Token C
    const finalAmount = afterSecondSwap.mul(rate3).mul(decimal_js_1.Decimal.sub(1, fee)); // Token C -> Token A
    return finalAmount.sub(startAmount); // Net profit
};
const triangularArbitrage = async () => {
    try {
        const MIN_PROFIT_THRESHOLD = 0.1;
        // Step 1: Fetch pools (e.g., SOL/USDC, USDC/ETH, ETH/SOL)
        const pool1 = orca.getPool(sdk_1.OrcaPoolConfig.SOL_USDC);
        const pool2 = orca.getPool(sdk_1.OrcaPoolConfig.ETH_USDC);
        const pool3 = orca.getPool(sdk_1.OrcaPoolConfig.ETH_SOL);
        // Step 2: Fetch token exchange rates
        const solToUsdcRate = (await pool1.getQuote(pool1.getTokenA(), new decimal_js_1.Decimal(1))).getRate(); // SOL -> USDC
        const usdcToEthRate = (await pool2.getQuote(pool2.getTokenA(), new decimal_js_1.Decimal(1))).getRate(); // USDC -> ETH
        const ethToSolRate = (await pool3.getQuote(pool3.getTokenA(), new decimal_js_1.Decimal(1))).getRate(); // ETH -> SOL
        console.log(`Rates: SOL -> USDC: ${solToUsdcRate}, USDC -> ETH: ${usdcToEthRate}, ETH -> SOL: ${ethToSolRate}`);
        // Step 3: Calculate profit
        const swapFee = new decimal_js_1.Decimal(0.003); // Orca swap fee (0.3%)
        const startAmount = new decimal_js_1.Decimal(1); // Start with 1 SOL
        const profit = calculateProfit(startAmount, solToUsdcRate, usdcToEthRate, ethToSolRate, swapFee);
        const profitPercentage = profit.div(startAmount).mul(100);
        console.log(`Calculated Profit: ${profit.toFixed(6)} SOL (${profitPercentage.toFixed(2)}%)`);
        // Step 4: Execute arbitrage if profitable
        if (profitPercentage.gte(MIN_PROFIT_THRESHOLD)) {
            console.log("Profitable arbitrage opportunity found! Executing trades...");
            // Get quote for SOL -> USDC swap
            const solToUsdcQuote = await pool1.getQuote(pool1.getTokenA(), new decimal_js_1.Decimal(1));
            // Execute SOL -> USDC swap
            const solToUsdcTrade = await pool1.swap(wallet, pool1.getTokenA(), new decimal_js_1.Decimal(1), new decimal_js_1.Decimal(0.01));
            console.log(`SOL -> USDC swap transaction: ${solToUsdcTrade}`);
            // Get quote for USDC -> ETH swap
            const usdcToEthQuote = await pool2.getQuote(pool2.getTokenA(), new decimal_js_1.Decimal(1));
            // Execute USDC -> ETH swap
            const usdcToEthTrade = await pool2.swap(wallet, pool2.getTokenA(), solToUsdcQuote.getMinOutputAmount(), new decimal_js_1.Decimal(0.01));
            console.log(`USDC -> ETH swap transaction: ${usdcToEthTrade}`);
            // Execute ETH -> SOL swap
            const ethToSolTrade = await pool3.swap(wallet, pool3.getTokenA(), usdcToEthQuote.getMinOutputAmount(), new decimal_js_1.Decimal(0.01));
            console.log(`ETH -> SOL swap transaction: ${ethToSolTrade}`);
            console.log("Arbitrage completed successfully!");
        }
        else {
            console.log("No profitable opportunities found.");
        }
    }
    catch (error) {
        console.error("Error during arbitrage execution:", error);
    }
};
