import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import splToken from "@solana/spl-token";
import {
  Orca,
  OrcaPool,
  OrcaPoolConfig,
  getOrca,
  OrcaU64,
  OrcaToken,
} from "@orca-so/sdk";
import { Decimal } from "decimal.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT_THRESHOLD = process.env.ARB_THRESHOLD || 0.02;

const connection = new Connection(RPC_URL!, {
  commitment: "confirmed",
  confirmTransactionInitialTimeout: 60000,
});

(async () => {
  const blockHeight = await connection.getBlockHeight();
  console.log("Current Block Height:", blockHeight);
  console.log("RPC enpoint is connected.");
})();

const decodeKey = bs58.decode(PRIVATE_KEY!);
const wallet = Keypair.fromSecretKey(Uint8Array.from(decodeKey!));

const calculateProfit = (
  startAmount: Decimal,
  rate1: Decimal,
  rate2: Decimal,
  rate3: Decimal,
  fee: Decimal
) => {
  const afterFirstSwap = startAmount.mul(rate1).mul(Decimal.sub(1, fee)); // Token A -> Token B
  const afterSecondSwap = afterFirstSwap.mul(rate2).mul(Decimal.sub(1, fee)); // Token B -> Token C
  const finalAmount = afterSecondSwap.mul(rate3).mul(Decimal.sub(1, fee)); // Token C -> Token A
  return finalAmount.sub(startAmount); // Net profit
};

const performSwap = async (
  orcaPool: OrcaPool,
  inputAmount: any,
  slippageTolerance: any,
  fee: any
) => {
  const { outputAmount, minOutputAmount } = await calculateOutAmount(
    orcaPool,
    inputAmount,
    fee,
    slippageTolerance
  );
  const TransactionPayload = await orcaPool.swap(
    wallet,
    orcaPool.getTokenA(),
    inputAmount,
    minOutputAmount
  );
  const signature = TransactionPayload.execute();

  console.log(
    `${
      orcaPool.getTokenA().tag
    } swap transaction: ${signature} swaped ${outputAmount}`
  );
  return outputAmount;
};

const calculateOutAmount = async (
  orcaPool: OrcaPool,
  inputAmount: Decimal | number,
  fee: any,
  slippageTolerance: any
) => {
  const tokenAInfo = await connection.getTokenAccountBalance(
    new PublicKey(orcaPool.getTokenA().addr)
  );
  const tokenBInfo = await connection.getTokenAccountBalance(
    new PublicKey(orcaPool.getTokenB().addr)
  );
  const reserveA = new Decimal(tokenAInfo.value.amount); // Reserve of Token A
  const reserveB = new Decimal(tokenBInfo.value.amount); // Reserve of Token B
  const inputAfterFee = new Decimal(inputAmount).mul(new Decimal(1).sub(fee));
  const outputAmount = reserveB
    .mul(inputAfterFee)
    .div(reserveA.add(inputAfterFee));
  const minOutputAmount = outputAmount.mul(
    new Decimal(1).sub(slippageTolerance)
  );
  return { outputAmount, minOutputAmount };
};

const getTokenAccounts = async () => {
  const tokens = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    }
  );
  return tokens;
};

const getTokenBalance = async (mintAddress: string) => {
  const tokens = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { mint: new PublicKey(mintAddress) }
  );
  return tokens.value.length
    ? tokens.value[0].account.data.parsed.info.tokenAmount.uiAmount
    : 0;
};

const runBot = async () => {
  while (true) {
    try {
      const orca = getOrca(connection);
      console.log("Pools initialized.");
      const solUsdcPool = orca.getPool(OrcaPoolConfig.SOL_USDC);
      const ethUsdcPool = orca.getPool(OrcaPoolConfig.ETH_USDC);
      const ethSolPool = orca.getPool(OrcaPoolConfig.ETH_SOL);

      /************************** Get Exchange Rate **********************/

      const solUsdcTokenABalance = await connection.getTokenAccountBalance(
        solUsdcPool.getTokenA().addr
      );
      const solUsdcTokenBBalance = await connection.getTokenAccountBalance(
        solUsdcPool.getTokenB().addr
      );
      const ethUsdcTokenABalance = await connection.getTokenAccountBalance(
        ethUsdcPool.getTokenA().addr
      );
      const ethUsdcTokenBBalance = await connection.getTokenAccountBalance(
        ethUsdcPool.getTokenB().addr
      );
      const ethSolTokenABalance = await connection.getTokenAccountBalance(
        ethSolPool.getTokenA().addr
      );
      const ethSolTokenBBalance = await connection.getTokenAccountBalance(
        ethSolPool.getTokenB().addr
      );
      const solUsdcTokenAAmount =
        parseFloat(solUsdcTokenABalance.value.amount) /
        Math.pow(10, solUsdcPool.getTokenA().scale);
      const solUsdcTokenBAmount =
        parseFloat(solUsdcTokenBBalance.value.amount) /
        Math.pow(10, solUsdcPool.getTokenB().scale);
      const ethUsdcTokenAAmount =
        parseFloat(ethUsdcTokenABalance.value.amount) /
        Math.pow(10, ethUsdcPool.getTokenA().scale);
      const ethUsdcTokenBAmount =
        parseFloat(ethUsdcTokenBBalance.value.amount) /
        Math.pow(10, ethUsdcPool.getTokenB().scale);
      const ethSolTokenAAmount =
        parseFloat(ethSolTokenABalance.value.amount) /
        Math.pow(10, ethSolPool.getTokenA().scale);
      const ethSolTokenBAmount =
        parseFloat(ethSolTokenBBalance.value.amount) /
        Math.pow(10, ethSolPool.getTokenB().scale);
      console.log(
        `Exchange Rate (SOL → USDC): ${
          solUsdcTokenBAmount / solUsdcTokenAAmount
        }`
      );
      console.log(
        `Exchange Rate (USDC → ETH): ${
          ethUsdcTokenAAmount / ethUsdcTokenBAmount
        }`
      );
      console.log(
        `Exchange Rate (ETH → SOL): ${ethSolTokenBAmount / ethSolTokenAAmount}`
      );
      const solToUsdcRate = Decimal(solUsdcTokenBAmount / solUsdcTokenAAmount);
      const usdcToEthRate = Decimal(ethUsdcTokenAAmount / ethUsdcTokenBAmount);
      const ethToSolRate = Decimal(ethSolTokenBAmount / ethSolTokenAAmount);

      /********************* Get Transaction Fee **************************/

      const amountToSwap = new Decimal(0.1); // Swap 0.1 SOL
      const slippage = new Decimal(0.01); // 1% slippage tolerance

      const solUsdcSwapTranPayload = await solUsdcPool.swap(
        wallet, // Wallet used to sign the transaction
        solUsdcPool.getTokenA(), // Token A (SOL) being swapped
        amountToSwap, // Amount of SOL to swap
        slippage // Slippage tolerance
      );
      const latestBlockhash = await connection.getLatestBlockhash();
      const solUsdcSwapTransaction = solUsdcSwapTranPayload.transaction;
      solUsdcSwapTransaction.recentBlockhash = latestBlockhash.blockhash;
      const solUsdcMessage = solUsdcSwapTransaction.compileMessage();

      // Calculate the fee for the transaction
      const solUsdcFee = await connection.getFeeForMessage(solUsdcMessage);
      let swapFee = 0;
      if (solUsdcFee.value !== null) {
        console.log(`Transaction Fee: ${solUsdcFee.value / 1_000_000_000} SOL`);
        swapFee = solUsdcFee.value / 1_000_000_000;
      } else {
        console.log("Unable to calculate the fee. Blockhash might be invalid.");
      }

      /*********************** Calculate profit ****************************/
      const startAmount = new Decimal(1);
      const profit = calculateProfit(
        startAmount,
        solToUsdcRate,
        usdcToEthRate,
        ethToSolRate,
        Decimal(swapFee)
      );
      const profitPercentage = profit.div(startAmount).mul(100);
      console.log(
        `Calculated Profit: ${profit.toFixed(
          6
        )} SOL (${profitPercentage.toFixed(2)}%)`
      );
      const MIN_SWAP_AMOUNT = 1;
      let balance = 0;
      await connection.getBalance(wallet.publicKey).then((value) => {
        console.log(`Wallet SOL balance: ${value} SOL`);
        balance = value;
      });
      const inputSOLInLamports = new Decimal(MIN_SWAP_AMOUNT).mul(
        new Decimal(1e9)
      );
      if (balance >= MIN_SWAP_AMOUNT)
        if (profitPercentage.gt(MIN_PROFIT_THRESHOLD)) {
          //MIN_SWAP_AMOUNT
          let outputAmount = performSwap(
            solUsdcPool,
            inputSOLInLamports,
            slippage,
            swapFee
          );
          outputAmount = performSwap(
            ethUsdcPool,
            outputAmount,
            slippage,
            swapFee
          );
          outputAmount = performSwap(
            ethSolPool,
            outputAmount,
            slippage,
            swapFee
          );
        }
    } catch (err) {
      console.log("ERROR: ", err);
    }
  }
};

runBot();
