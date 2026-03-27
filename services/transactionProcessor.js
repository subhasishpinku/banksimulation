// services/transactionProcessor.js
import mongoose from 'mongoose';
import Transaction from '../models/Transaction.js';
import BankAccount from '../models/BankAccount.js';
import Notification from '../models/Notification.js';
import { generateReferenceNumber } from '../utils/helpers.js';

export async function processScheduledTransactions() {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const now = new Date();
    
    // Find all pending/scheduled transactions that are due
    const scheduledTransactions = await Transaction.find({
      status: 'PENDING',
      scheduledDate: { $lte: now },
      $or: [
        { isRecurring: false },
        { isRecurring: true }
      ]
    }).session(session);

    console.log(`Processing ${scheduledTransactions.length} scheduled transactions`);

    for (const scheduledTx of scheduledTransactions) {
      const senderAccount = await BankAccount.findOne({ 
        userId: scheduledTx.userId 
      }).session(session);
      
      const receiverAccount = await BankAccount.findOne({ 
        accountNumber: scheduledTx.counterpartyAccount 
      }).session(session);

      if (!senderAccount || !receiverAccount) {
        scheduledTx.status = 'FAILED';
        await scheduledTx.save({ session });
        continue;
      }

      if (scheduledTx.amount > senderAccount.balance) {
        scheduledTx.status = 'FAILED';
        await scheduledTx.save({ session });
        
        // Send insufficient balance notification
        const notification = new Notification({
          userId: scheduledTx.userId,
          notificationId: `NOTIF${Date.now()}`,
          title: 'Scheduled Transfer Failed',
          message: `Scheduled transfer of ₹${scheduledTx.amount.toLocaleString('en-IN')} failed due to insufficient balance`,
          type: 'ALERT',
          data: { transactionId: scheduledTx.transactionId }
        });
        await notification.save({ session });
        continue;
      }

      // Process the transfer
      senderAccount.balance -= scheduledTx.amount;
      await senderAccount.save({ session });

      receiverAccount.balance += scheduledTx.amount;
      await receiverAccount.save({ session });

      scheduledTx.status = 'SUCCESS';
      scheduledTx.balanceAfterTransaction = senderAccount.balance;
      await scheduledTx.save({ session });

      // Create credit transaction for receiver
      const creditTransaction = new Transaction({
        userId: receiverAccount.userId,
        accountId: receiverAccount._id,
        transactionId: generateReferenceNumber(),
        amount: scheduledTx.amount,
        type: 'CREDIT',
        description: scheduledTx.description,
        counterparty: senderAccount.accountHolderName,
        counterpartyAccount: senderAccount.accountNumber,
        counterpartyBank: senderAccount.bankName,
        status: 'SUCCESS',
        referenceNumber: generateReferenceNumber(),
        balanceAfterTransaction: receiverAccount.balance
      });
      await creditTransaction.save({ session });

      // Send success notification
      const notification = new Notification({
        userId: scheduledTx.userId,
        notificationId: `NOTIF${Date.now()}`,
        title: 'Scheduled Transfer Completed',
        message: `₹${scheduledTx.amount.toLocaleString('en-IN')} transferred to ${receiverAccount.accountHolderName}`,
        type: 'TRANSACTION',
        data: { transactionId: scheduledTx.transactionId }
      });
      await notification.save({ session });

      // Handle recurring transactions
      if (scheduledTx.isRecurring && scheduledTx.recurringType) {
        let nextDate;
        const currentDate = new Date(scheduledTx.scheduledDate);
        
        switch (scheduledTx.recurringType) {
          case 'DAILY':
            nextDate = new Date(currentDate.setDate(currentDate.getDate() + 1));
            break;
          case 'WEEKLY':
            nextDate = new Date(currentDate.setDate(currentDate.getDate() + 7));
            break;
          case 'MONTHLY':
            nextDate = new Date(currentDate.setMonth(currentDate.getMonth() + 1));
            break;
        }

        // Create next occurrence
        const nextTransaction = new Transaction({
          userId: scheduledTx.userId,
          accountId: scheduledTx.accountId,
          transactionId: generateReferenceNumber(),
          amount: scheduledTx.amount,
          type: scheduledTx.type,
          description: scheduledTx.description,
          counterparty: scheduledTx.counterparty,
          counterpartyAccount: scheduledTx.counterpartyAccount,
          counterpartyBank: scheduledTx.counterpartyBank,
          status: 'PENDING',
          referenceNumber: generateReferenceNumber(),
          scheduledDate: nextDate,
          isRecurring: true,
          recurringType: scheduledTx.recurringType
        });
        await nextTransaction.save({ session });
      }
    }

    await session.commitTransaction();
    return { success: true, processed: scheduledTransactions.length };
  } catch (error) {
    await session.abortTransaction();
    console.error('Error processing scheduled transactions:', error);
    return { success: false, error: error.message };
  } finally {
    session.endSession();
  }
}