import { signAndSendInstructions } from "@bonfida/utils";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { placeOrder, consumeEvents, swap } from "./bindings";
import BN from "bn.js";
import { UserAccount, MarketState } from "./state";
import { DEX_ID } from "./ids";
import { AccountLayout } from "@solana/spl-token";
import { Side } from "@bonfida/aaob";
import { OrderType, SelfTradeBehavior } from "./types";
import { Market } from "./market";
import { createContext, initializeTraders } from "./utils/context";
import { computeTakerFee } from "./utils/fee";
import { random } from "./utils/random";
import { computeFp32Price } from "./utils";
import { checkTokenBalances } from "./utils/token-balances";

export const swapTest = async (
  connection: Connection,
  feePayer: Keypair,
  Alice: Keypair,
  Bob: Keypair,
  baseDecimals: number,
  quoteDecimals: number,
  minPrice: number,
  maxPrice: number,
  minUiTradeSize: number,
  maxUiTradeSize: number,
  maxTickSize: number,
  baseCurrencyMultiplier?: BN,
  quoteCurrencyMultiplier?: BN
) => {
  const baseTokenAmount =
    random(maxUiTradeSize, 2 * maxUiTradeSize, true) *
    Math.pow(10, baseDecimals);
  const quoteTokenAmount =
    random(2 * maxUiTradeSize, maxPrice * (2 * maxUiTradeSize), true) *
    Math.pow(10, quoteDecimals);
  /**
   * Initialize market and traders
   */
  const tickSize = new BN(random(0, maxTickSize) * 2 ** 32);
  const minBaseOrderSize = new BN(1);

  const { marketKey, base, quote } = await createContext(
    connection,
    feePayer,
    tickSize,
    minBaseOrderSize,
    baseDecimals,
    quoteDecimals,
    baseCurrencyMultiplier,
    quoteCurrencyMultiplier
  );

  let marketState = await MarketState.retrieve(connection, marketKey);
  console.log("market state init: ", {
    accumulatedFees: marketState.accumulatedFees.toNumber(),
    accumulatedRoyalties: marketState.accumulatedRoyalties.toNumber(),
    baseVolume: marketState.baseVolume.toNumber(),
    quoteVolume: marketState.quoteVolume.toNumber(),
  });
  console.log("============= Init traders ==================");
  const { aliceBaseAta, bobBaseAta, bobQuoteAta } = await initializeTraders(
    connection,
    base,
    quote,
    Alice,
    Bob,
    feePayer,
    marketKey,
    baseTokenAmount,
    quoteTokenAmount
  );

  let market = await Market.load(connection, marketKey);
  console.log({ market });
  const swapSize =
    Math.pow(10, baseDecimals) * random(minUiTradeSize, maxUiTradeSize, true);
  const swapPrice = random(minPrice, maxPrice);

  console.log("=================Place an ask==========================");
  console.log({ swapSize, swapPrice });
  let tx = await signAndSendInstructions(connection, [Alice], feePayer, [
    await placeOrder(
      market,
      Side.Ask, // Bid side
      swapPrice,
      swapSize,
      OrderType.Limit,
      SelfTradeBehavior.AbortTransaction,
      aliceBaseAta,
      Alice.publicKey
    ),
  ]);
  console.log(`placed order ${tx}`);

  /**
   * Check user account
   */
  const [bobUa] = await PublicKey.findProgramAddress(
    [marketKey.toBuffer(), Bob.publicKey.toBuffer()],
    DEX_ID
  );
  const [aliceUa] = await PublicKey.findProgramAddress(
    [marketKey.toBuffer(), Alice.publicKey.toBuffer()],
    DEX_ID
  );
  let aliceUserAccount = await UserAccount.retrieve(connection, aliceUa);

  console.log({
    baseTokenFee: aliceUserAccount.baseTokenFree.toNumber(),
    baseTokenLocked: aliceUserAccount.baseTokenLocked.toNumber(),
    quoteTokenFree: aliceUserAccount.quoteTokenFree.toNumber(),
    quoteTokenLocked: aliceUserAccount.quoteTokenLocked.toNumber(),
    accumulatedRebates: aliceUserAccount.accumulatedRebates.toNumber(),
    accumulatedMakerQuoteVolume: aliceUserAccount.accumulatedMakerQuoteVolume,
    accumulatedMakerBaseVolume: aliceUserAccount.accumulatedMakerBaseVolume,
    accumulatedTakerQuoteVolume: aliceUserAccount.accumulatedTakerQuoteVolume,
    accumulatedTakerBaseVolume: aliceUserAccount.accumulatedTakerBaseVolume,
    order_length: aliceUserAccount.orders.length,
  });

  console.log("=================BID: swap an ask==========================");

  tx = await signAndSendInstructions(connection, [Bob], feePayer, [
    await swap(
      market,
      Side.Bid,
      swapSize,
      quoteTokenAmount,
      SelfTradeBehavior.AbortTransaction,
      bobBaseAta,
      bobQuoteAta,
      Bob.publicKey
    ),
    await consumeEvents(
      market,
      feePayer.publicKey,
      [aliceUa, bobUa],
      new BN(10),
      new BN(1)
    ),
  ]);
  console.log(`swapped ${tx}`);

  const executionPrice = computeFp32Price(market, swapPrice);
  const takerFees = computeTakerFee(
    new BN(swapSize)
      .mul(executionPrice)
      .shrn(32)
      .mul(market.quoteCurrencyMultiplier)
      .div(market.baseCurrencyMultiplier)
  );

  marketState = await MarketState.retrieve(connection, marketKey);
  console.log({
    executionPrice: executionPrice.toNumber(),
    takerFees: takerFees.toNumber(),
  });
  console.log("market state after swap: ", {
    accumulatedFees: marketState.accumulatedFees.toNumber(),
    accumulatedRoyalties: marketState.accumulatedRoyalties.toNumber(),
    baseVolume: marketState.baseVolume.toNumber(),
    quoteVolume: marketState.quoteVolume.toNumber(),
  });
};

(async () => {
  const connection = new Connection(
    "https://api-testnet.renec.foundation:8899/",
    "confirmed"
  );
  const feePayer = Keypair.fromSecretKey(
    new Uint8Array([
      118, 130, 31, 252, 203, 243, 164, 109, 173, 93, 102, 133, 32, 14, 125,
      186, 247, 119, 43, 207, 219, 170, 111, 242, 122, 114, 74, 96, 96, 170,
      247, 49, 118, 99, 1, 21, 48, 101, 114, 249, 176, 184, 211, 231, 212, 90,
      44, 33, 167, 74, 165, 51, 185, 216, 15, 177, 109, 131, 225, 221, 217, 56,
      157, 125,
    ])
  );
  const Alice = Keypair.fromSecretKey(
    new Uint8Array([
      122, 98, 243, 214, 169, 11, 173, 244, 103, 233, 145, 152, 95, 251, 245,
      240, 42, 9, 103, 87, 160, 242, 153, 33, 121, 1, 74, 110, 84, 240, 223, 51,
      12, 10, 91, 219, 36, 70, 248, 246, 103, 253, 143, 210, 195, 242, 2, 32,
      56, 187, 63, 191, 200, 249, 193, 228, 92, 218, 181, 57, 152, 103, 73, 239,
    ])
  );
  const Bob = Keypair.fromSecretKey(
    new Uint8Array([
      30, 217, 232, 2, 184, 217, 7, 79, 146, 61, 198, 16, 56, 5, 77, 150, 174,
      129, 210, 79, 27, 255, 190, 175, 249, 8, 205, 170, 25, 120, 178, 249, 22,
      127, 253, 213, 198, 247, 139, 225, 219, 30, 88, 251, 225, 164, 169, 30,
      45, 112, 71, 61, 150, 84, 103, 60, 186, 99, 60, 120, 197, 137, 254, 84,
    ])
  );
  await swapTest(
    connection,
    feePayer,
    Alice,
    Bob,
    6,
    6,
    100,
    1_000,
    10,
    100,
    2
  );
})();
