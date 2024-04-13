import { send_transactions, validateSolAddress, getKeypairFromBs58, generate_transactions, serializeTransactions, getComputeUnitsForTransaction, getPriorityFeeEstimateForTransaction, getOptimalPriceAndBudget, ConstructOptimalTransaction, getRandomNumber, buildBundle, onBundleResult, getCurrentTime } from "../utils";
import idl from "../constants/idl.json";
import { TransactionInstruction, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, Transaction, sendAndConfirmRawTransaction, PartiallyDecodedInstruction, ParsedInstruction, ParsedInnerInstruction, ParsedTransaction, ParsedTransactionWithMeta, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import fs from "fs";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import readline from "readline";
import bs58 from "bs58";
import dotenv from "dotenv";
import { parseSignatures } from "../utils";

import { sleep, getUserInput } from "../utils";
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";




process.removeAllListeners('warning')


async function main() {

    try {

        const programID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
        const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'


        //loading env variables from .env file
        dotenv.config();
        const pk = process.env.SIGNER_PRIVATE_KEY;
        const url = process.env.RPC_URL;


        if (!pk || !url) {
            console.log('missing required environment variables');
            console.log('please populate .env file');
            return
        }

        const connection = new Connection(process.env.RPC_URL as string, { commitment: 'confirmed', });
        const signerKeypair = getKeypairFromBs58(pk);

        //getting the  wallet to track:
        const inputtedWallet = (await getUserInput("Enter the wallet address to monitor: "));
        if (!validateSolAddress(inputtedWallet)) {
            console.log('invalid wallet address');
            return;
        }

        //getting the amount to snipe with:
        const inputtedAmount = (await getUserInput("Enter the amount of SOL to snipe with: "));
        const numberAmount = Number(inputtedAmount);
        if (!numberAmount) {
            console.log('invalid sol amount');
            return;
        }

        //getting the amount to snipe with:
        const inputtedMaxSolCost = (await getUserInput("Enter the maximum amount of SOL accounting to slippage: "));
        const maxSolCost = Number(inputtedMaxSolCost);
        if (!maxSolCost || maxSolCost < numberAmount) {
            console.log('invalid maximum sol amount');
            return;
        }

        //getting the amount to snipe with:
        let priorityFee: number = -1;
        const inputtedPriorityFee = (await getUserInput("Enter Priority-fee in micro-lamports ('default' for default fee <1,000,000>): "));
        if (inputtedPriorityFee.toUpperCase() != 'DEFAULT') {
            priorityFee = Number(inputtedPriorityFee);
            if (!priorityFee || priorityFee < 0) {
                console.log('invalid priority fee input');
                return
            }
        }


        //using jito block engine:
        let useJito: boolean = false;
        const isUsingJito = (await getUserInput("Use Jito block engine? (y/n): ")).toUpperCase();
        if (isUsingJito == 'Y') {
            useJito = true;
        } else if (isUsingJito == "N") {
            useJito = false;
        } else {
            console.log('invalid input');
            return
        }

        console.log('\n');
        console.log(`Scanning wallet ${inputtedWallet}\n`)



        //caching to avoid accidental duplicate on-chain reads 
        //var cache: Set<string> = new Set();
        //
        //setInterval(() => {
        //    cache.clear();
        //    console.log("cache flushed");
        //}, 3 * 60 * 1000);



        //start monitoring

        let neededInstruction: PartiallyDecodedInstruction | ParsedInstruction | null = null;
        let parsedSig: ParsedTransactionWithMeta | null = null

        while (neededInstruction == null) {
            const data = await connection.getConfirmedSignaturesForAddress2(new PublicKey(inputtedWallet), { limit: 10, },);
            const confirmed_sigs: string[] = data.filter(e => !e.err).map(e => e.signature);

            if (confirmed_sigs.length === 0) {
                await sleep(500);
                console.log('No signatures found, polling for new signatures..')
                continue
            }
            //console.log(confirmed_sigs);

            const parsed_sigs = await parseSignatures(connection, confirmed_sigs);


            for (var i = 0; i < parsed_sigs.length; i++) {
                try {
                    const sig = parsed_sigs[i];
                    if (!sig) { continue }

                    const blockTime = sig.blockTime;
                    const currentTime = Math.floor(Date.now() / 1000);


                    //transaction should should be processed within one minute of detecting it here
                    //const currentTime = Math.floor(Date.now() / 1000);
                    //const blockTime = sig?.blockTime;
                    //if (!blockTime || currentTime - blockTime < 60) {
                    //    console.log('Old bonding curve detected. Ignoring...')
                    //    continue
                    //};
                    //@ts-ignore

                    const instructions = (sig.transaction.message.instructions);
                    for (let ix of instructions) {
                        try {
                            const hasNeededProgramId = (ix.programId.toBase58() == programID);
                            //@ts-ignore
                            //console.log(ix.accounts.length);
                            //console.log(ix.programId.toBase58());
                            //console.log(confirmed_sigs[i])


                            //@ts-ignore
                            const hasNeededAccounts = ix.accounts.length == 12;

                            if (hasNeededProgramId && hasNeededAccounts) {
                                if (!blockTime || currentTime - blockTime > 60) {
                                    console.log(`${getCurrentTime()} Old Bonding Curve detected, Ignoring stale pool...`)
                                }else {
                                    neededInstruction = ix;
                                    parsedSig = sig
                                    break
                                }
                            }
                        } catch (e) {
                            continue
                        }
                    }
                    if (neededInstruction) { break };

                } catch (e) {
                    continue
                }
                if (neededInstruction) { break };
            }

            console.log(`${getCurrentTime()} No bonding curves found. Polling for new signatures...\n`);
            await sleep(500);

        }


        if (!neededInstruction) { return }

        console.log(`\nFound new pool/bonding-curve, Sniping with ${numberAmount} SOL..`);

        //initializing program
        const program = new Program(idl as anchor.Idl, programID, new anchor.AnchorProvider(connection, new NodeWallet(signerKeypair), anchor.AnchorProvider.defaultOptions()));


        //@ts-ignore

        //getting needed accounts
        const accounts = neededInstruction.accounts
        const mint = accounts[0];
        const mintAuth = accounts[1];
        const bondingCurve = accounts[2];
        const bondingCurveAta = accounts[3];
        const globalState = accounts[4];
        const user = signerKeypair.publicKey;
        const userAta = getAssociatedTokenAddressSync(mint, user, true);
        const feeRecipient = (await program.account.global.fetch(globalState)).feeRecipient as PublicKey;
        const signerTokenAccount = getAssociatedTokenAddressSync(mint, user, true, TOKEN_PROGRAM_ID,);
        const account = await connection.getAccountInfo(signerTokenAccount, 'processed');

        const bondingCurveData = await program.account.bondingCurve.fetch(bondingCurve);
        const mintData = await connection.getParsedAccountInfo(mint);

        //@ts-ignore
        const decimals = mintData.value?.data.parsed.info.decimals;
        const virtualTokenReserves = (bondingCurveData.virtualTokenReserves as any).toNumber();
        const virtualSolReserves = (bondingCurveData.virtualSolReserves as any).toNumber();

        const adjustedVirtualTokenReserves = virtualTokenReserves / (10 ** decimals);
        const adjustedVirtualSolReserves = virtualSolReserves / LAMPORTS_PER_SOL;


        const virtualTokenPrice = adjustedVirtualSolReserves / adjustedVirtualTokenReserves;
        const finalAmount = (numberAmount / virtualTokenPrice);


        //console.log(adjustedVirtualSolReserves);
        //console.log(adjustedVirtualTokenReserves);
        //
        //console.log(finalAmount);
        //console.log(virtualTokenPrice);
        //console.log(virtualTokenReserves);
        //console.log(virtualSolReserves);
        //console.log(decimals);
        //console.log(mint);
        //console.log(bondingCurve);
        //console.log(finalAmount);


        while (true) {

            //creating tx;
            const tx = new Transaction();

            if (!account) {
                tx.add(
                    createAssociatedTokenAccountInstruction(
                        user,
                        signerTokenAccount,
                        user,
                        mint,
                    )
                )
            };


            const snipeIx = await program.methods.buy(
                new BN((finalAmount * (10 ** decimals))),
                new BN(maxSolCost * LAMPORTS_PER_SOL),
            ).accounts({
                global: globalState,
                feeRecipient: feeRecipient,
                mint: mint,
                bondingCurve: bondingCurve,
                associatedBondingCurve: bondingCurveAta,
                associatedUser: userAta,
                user: user,
                systemProgram: SystemProgram.programId,
                tokenProgram: TOKEN_PROGRAM_ID,
                rent: SYSVAR_RENT_PUBKEY,
            }).instruction();
            tx.add(snipeIx);


            const memoix = new TransactionInstruction({
                programId: new PublicKey(MEMO_PROGRAM_ID),
                keys: [],
                data: Buffer.from(getRandomNumber().toString(), "utf8")
            })
            tx.add(memoix);

            //preparing transaction
            const hashAndCtx = await connection.getLatestBlockhashAndContext('processed');
            const recentBlockhash = hashAndCtx.value.blockhash;
            const lastValidBlockHeight = hashAndCtx.value.lastValidBlockHeight;

            tx.recentBlockhash = recentBlockhash;
            tx.lastValidBlockHeight = lastValidBlockHeight;
            tx.feePayer = user;

            const finalTx = await ConstructOptimalTransaction(tx, connection, priorityFee);

            finalTx.sign(signerKeypair);


            if (useJito) {

                const jitoAuthPrivateKey = process.env.JITO_AUTH_PRIVATE_KEY as string;
                if (!jitoAuthPrivateKey) {
                    console.log('Missing jito authentication private key');
                    console.log('please fill it in the .env file.');
                    return
                }

                const blockEngineUrl = process.env.BLOCK_ENGINE_URL as string;
                if (!blockEngineUrl) {
                    console.log('Missing block engine url');
                    console.log('please fill it in the .env file.');
                    return
                }

                const envTip = process.env.JITO_TIP as string;
                const jitoTip = Number(envTip);
                if (!jitoTip) {
                    console.log('invalid jito tip');
                    console.log('please fix it in the .env file.');
                    return
                }

                const jitoAuthKeypair = getKeypairFromBs58(jitoAuthPrivateKey);


                const bundleTransactionLimit = 1;
                const search = searcherClient(blockEngineUrl, jitoAuthKeypair);

                const bundleCtx = await buildBundle(
                    search,
                    bundleTransactionLimit,
                    finalTx,
                    signerKeypair,
                    jitoTip,
                );

                if (bundleCtx != null) {
                    const bundleResult = await onBundleResult(search);
                    if (bundleResult) {
                        console.log('Successful! ');
                        process.exit(0);
                    } else {
                        console.log('Failed to send Bundle, retrying... (ctrl + c to abort)');
                        continue
                    }
                } else {
                    throw new Error
                }

            } else {
                const res = await send_transactions(Array(1).fill(finalTx), connection);

                const isSuccessful = (res.filter(e => e != 'failed'));

                //console.log(isSuccessful);

                if (isSuccessful.length == 0) {
                    console.log('Failed to send Transaction, retrying.. (ctrl + c to abort)')
                    continue
                } else {
                    console.log('Transaction Successful with signature: ', isSuccessful[0]);
                    process.exit(0);
                }
            }

        }

    } catch (e) {
        console.log(e);
        console.log('an error has occurred');
    }
}

main()