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
import { trace } from "console";

dotenv.config();

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const MIN_PROFIT_THRESHOLD = process.env.ARB_THRESHOLD || 0.02;
const BASE_FEE = process.env.BASE_FEE;
const PRIORITY_FEE = Number(process.env.PRIORITY_FEE) || 100000; // Default to 100000 lamports if not set

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

const calculatePriorityFee = async (transaction: any) => {
  const blockhashInfo = await connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhashInfo.blockhash;

  const feeInLamports = await connection.getFeeForMessage(
    transaction.compileMessage(), // Compile the transaction message
    "confirmed"
  );

  if (!feeInLamports.value) {
    console.log("Cannot fetch fees, defaulting to base fee.");
    return BASE_FEE;
  }

  const adjustedFee = Math.min(feeInLamports.value + 2000, PRIORITY_FEE); // Add buffer of 2000 lamports

  return adjustedFee;
};

const calculateProfit = (
  startAmount: Decimal,
  rate1: Decimal,
  rate2: Decimal,
  rate3: Decimal,
  swapfee1: Decimal,
  swapfee2: Decimal,
  swapfee3: Decimal,
  tranfee: Decimal
) => {
  const afterFirstSwap = startAmount.mul(rate1).mul(Decimal.sub(1, swapfee1)); // Token A -> Token B
  const afterSecondSwap = afterFirstSwap
    .mul(rate2)
    .mul(Decimal.sub(1, swapfee2)); // Token B -> Token C
  const finalAmount = afterSecondSwap.mul(rate3).mul(Decimal.sub(1, swapfee3)); // Token C -> Token A
  return finalAmount.sub(startAmount).sub(tranfee.mul(3)); // Net profit
};

const calculateSwapFee = async (pool: OrcaPool) => {
  // Get token reserves from pool
  const tokenABalance = await connection.getTokenAccountBalance(
    pool.getTokenA().addr
  );
  const tokenBBalance = await connection.getTokenAccountBalance(
    pool.getTokenB().addr
  );

  // Convert to decimal values
  const reserveA = new Decimal(tokenABalance.value.amount).div(
    Math.pow(10, pool.getTokenA().scale)
  );
  const reserveB = new Decimal(tokenBBalance.value.amount).div(
    Math.pow(10, pool.getTokenB().scale)
  );

  // Orca pools have a 0.3% fee (30 basis points)
  const FEE_NUMERATOR = 30;
  const FEE_DENOMINATOR = 10000;
  const fee = new Decimal(FEE_NUMERATOR).div(FEE_DENOMINATOR);

  // Calculate price impact based on reserves
  const priceImpact = reserveB.div(reserveA);

  // Calculate total swap fee including price impact
  const swapFee = priceImpact.mul(fee);

  return {
    fee: swapFee,
    reserveA: reserveA,
    reserveB: reserveB,
    priceImpact: priceImpact,
  };
};

const getBestPoolForPair = async (orca: Orca) => {
  let orcaPoolData = [];
  let bestPools = [];
  bestPools.push("SOL_USDC");
  for (const poolName of Object.keys(OrcaPoolConfig)) {
    if (poolName.includes("SOL")) {
      const pairNames = poolName.split("_");
      if (
        pairNames.length == 2 &&
        (pairNames.at(0) == "SOL" || pairNames.at(1) == "SOL")
      ) {
        const currentPool = orca.getPool(
          OrcaPoolConfig[poolName as keyof typeof OrcaPoolConfig]
        );
        const swapFeeData = await calculateSwapFee(currentPool);
        console.log(poolName, swapFeeData.fee);
        orcaPoolData.push({
          pairName: poolName,
          mintAddress: poolName as keyof typeof OrcaPoolConfig,
          fee: swapFeeData.fee,
          priceImpact: swapFeeData.priceImpact,
        });
      }
    }
  }

  // Sort by fee in descending order
  orcaPoolData.sort((a: any, b: any) => a.fee - b.fee);
  for (const value of orcaPoolData) {
    const pairNames = value.pairName.split("_");
    if (pairNames.at(0) == "SOL") {
      const target = Object.keys(OrcaPoolConfig).filter(
        (each) =>
          each.includes(pairNames.at(1) as string) && each.includes("USDC")
      );
      if (target.length == 1) {
        bestPools.push(target.at(0));
        bestPools.push(value.pairName);
        break;
      }
    } else if (pairNames.at(1) == "SOL") {
      const target = Object.keys(OrcaPoolConfig).filter(
        (each) =>
          each.includes(pairNames.at(0) as string) && each.includes("USDC")
      );
      if (target.length == 1) {
        bestPools.push(target.at(0));
        bestPools.push(value.pairName);
        break;
      }
    }
  }
  return bestPools;
};

const performSwap = async (
  orcaPool: OrcaPool,
  inputAmount: any,
  inputToken: OrcaToken,
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
    inputToken,
    inputAmount,
    minOutputAmount
  );
  const signature = TransactionPayload.execute();

  console.log(
    `${inputToken.tag} swap transaction: ${signature} swaped ${outputAmount}`
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
      const SwapPools = await getBestPoolForPair(orca);
      if (SwapPools.length != 3) break;
      const firstPool = orca.getPool(
        OrcaPoolConfig[SwapPools.at(0)! as keyof typeof OrcaPoolConfig]
      );
      const secondPool = orca.getPool(
        OrcaPoolConfig[SwapPools.at(1)! as keyof typeof OrcaPoolConfig]
      );
      const thirdPool = orca.getPool(
        OrcaPoolConfig[SwapPools.at(2)! as keyof typeof OrcaPoolConfig]
      );

      /************************** Get Exchange Rate **********************/

      const firstPairNames = SwapPools.at(0)?.split("_");
      const secondPairNames = SwapPools.at(1)?.split("_");
      const thirdPairNames = SwapPools.at(2)?.split("_");

      const firstTokenABalance = await connection.getTokenAccountBalance(
        firstPool.getTokenA().addr
      );
      const firstTokenBBalance = await connection.getTokenAccountBalance(
        firstPool.getTokenB().addr
      );
      const secondTokenABalance = await connection.getTokenAccountBalance(
        secondPool.getTokenA().addr
      );
      const secondTokenBBalance = await connection.getTokenAccountBalance(
        secondPool.getTokenB().addr
      );
      const thirdTokenABalance = await connection.getTokenAccountBalance(
        thirdPool.getTokenA().addr
      );
      const thirdTokenBBalance = await connection.getTokenAccountBalance(
        thirdPool.getTokenB().addr
      );
      const firstTokenAAmount =
        parseFloat(firstTokenABalance.value.amount) /
        Math.pow(10, firstPool.getTokenA().scale);
      const firstTokenBAmount =
        parseFloat(firstTokenBBalance.value.amount) /
        Math.pow(10, firstPool.getTokenB().scale);
      const secondTokenAAmount =
        parseFloat(secondTokenABalance.value.amount) /
        Math.pow(10, secondPool.getTokenA().scale);
      const secondTokenBAmount =
        parseFloat(secondTokenBBalance.value.amount) /
        Math.pow(10, secondPool.getTokenB().scale);
      const thirdTokenAAmount =
        parseFloat(thirdTokenABalance.value.amount) /
        Math.pow(10, thirdPool.getTokenA().scale);
      const thirdTokenBAmount =
        parseFloat(thirdTokenBBalance.value.amount) /
        Math.pow(10, thirdPool.getTokenB().scale);

      const firstRate = Decimal(firstTokenBAmount / firstTokenAAmount);
      const secondRate =
        firstPairNames?.at(1) == secondPairNames?.at(0)
          ? Decimal(secondTokenBAmount / secondTokenAAmount)
          : Decimal(secondTokenAAmount / secondTokenBAmount);
      const thirdRate = Decimal(thirdTokenBAmount / thirdTokenAAmount);
      console.log(
        `Exchange Rate (${firstPairNames?.at(0)} → ${firstPairNames?.at(
          1
        )}): ${firstRate}`
      );
      console.log(
        `Exchange Rate (${secondPairNames?.at(1)} → ${secondPairNames?.at(
          0
        )}): ${secondRate}`
      );
      console.log(
        `Exchange Rate (${thirdPairNames?.at(0)} → ${thirdPairNames?.at(
          1
        )}): ${thirdRate}`
      );

      /********************* Get Transaction Fee **************************/

      const amountToSwap = new Decimal(0.1); // Swap 0.1 SOL
      const slippage = new Decimal(0.01); // 1% slippage tolerance

      const SwapTranPayload = await secondPool.swap(
        secondPool.getTokenA().addr, // Wallet used to sign the transaction
        secondPool.getTokenA(), // Token A (SOL) being swapped
        amountToSwap, // Amount of SOL to swap
        slippage // Slippage tolerance
      );
      const latestBlockhash = await connection.getLatestBlockhash();
      const SwapTransaction = SwapTranPayload.transaction;
      SwapTransaction.recentBlockhash = latestBlockhash.blockhash;
      const SwapMessage = SwapTransaction.compileMessage();

      // Calculate the fee for the transaction
      const lamportsFee = await connection.getFeeForMessage(SwapMessage);
      let transFee = 0;
      if (lamportsFee.value !== null) {
        console.log(`Transaction Fee: ${lamportsFee.value / 1e9} SOL`);
        transFee = lamportsFee.value / 1e9;
      } else {
        console.log("Unable to calculate the fee. Blockhash might be invalid.");
      }

      /********************* Customize Priority Fee ***********************/

      const priorityFee: any = await calculatePriorityFee(
        SwapTranPayload.transaction
      );

      console.log(
        `Transaction sent with Priority Fee: ${priorityFee / 1e9} SOL`
      );
      console.log(`Transaction ID: ${SwapTranPayload.transaction.signature}`);

      /*********************** Calculate profit ****************************/
      const startAmount = new Decimal(1);
      const [firstSwapFee, secondSwapFee, thirdSwapFee] = await Promise.all([
        calculateSwapFee(firstPool),
        calculateSwapFee(secondPool),
        calculateSwapFee(thirdPool),
      ]);
      const profit = calculateProfit(
        startAmount,
        firstRate,
        secondRate,
        thirdRate,
        firstSwapFee.fee,
        secondSwapFee.fee,
        thirdSwapFee.fee,
        Decimal(transFee)
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
          let outputAmount = await performSwap(
            firstPool,
            inputSOLInLamports,
            firstPool.getTokenA(),
            slippage,
            firstSwapFee
          );
          outputAmount = await performSwap(
            secondPool,
            outputAmount,
            firstPairNames?.at(1) == secondPairNames?.at(0)
              ? secondPool.getTokenA()
              : secondPool.getTokenB(),
            slippage,
            secondSwapFee
          );
          outputAmount = await performSwap(
            thirdPool,
            outputAmount,
            thirdPool.getTokenA(),
            slippage,
            thirdSwapFee
          );
        }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      console.log("ERROR: ", err);
    }
  }
};

runBot();
