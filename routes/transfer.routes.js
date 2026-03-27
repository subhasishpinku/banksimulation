// routes/transfer.routes.js (Enhanced)
import express from 'express';
import auth from '../middleware/auth.js';
import mongoose from 'mongoose';
import BankAccount from '../models/BankAccount.js';
import Transaction from '../models/Transaction.js';
import InternationalTransfer from '../models/InternationalTransfer.js';
import ExchangeRate from '../models/ExchangeRate.js';
import Notification from '../models/Notification.js';
import { generateTransactionId, generateReferenceNumber } from '../utils/helpers.js';

const router = express.Router();

// ==================== DOMESTIC TRANSFER ====================
router.post('/domestic', auth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { 
      toAccountNumber, 
      toIfsc, 
      amount, 
      description,
      scheduledDate,
      isRecurring,
      recurringType
    } = req.body;

    const senderAccount = await BankAccount.findOne({ userId: req.userId }).session(session);
    if (!senderAccount) {
      throw new Error('Sender account not found');
    }

    const transferAmount = parseFloat(amount);
    if (transferAmount > senderAccount.balance) {
      throw new Error('Insufficient balance');
    }

    const receiverAccount = await BankAccount.findOne({ 
      accountNumber: toAccountNumber,
      ifscCode: toIfsc
    }).session(session);

    if (!receiverAccount) {
      throw new Error('Receiver account not found');
    }

    // Check if this is a scheduled transfer
    const isScheduled = scheduledDate && new Date(scheduledDate) > new Date();
    
    let transactionStatus = 'SUCCESS';
    let transferStatus = 'COMPLETED';
    
    if (isScheduled) {
      transactionStatus = 'PENDING';
      transferStatus = 'SCHEDULED';
    }

    // Deduct from sender only if not scheduled
    if (!isScheduled) {
      senderAccount.balance -= transferAmount;
      await senderAccount.save({ session });
      
      receiverAccount.balance += transferAmount;
      await receiverAccount.save({ session });
    }

    const debitTransaction = new Transaction({
      userId: req.userId,
      accountId: senderAccount._id,
      transactionId: generateTransactionId(),
      amount: transferAmount,
      type: 'DEBIT',
      description: description || `Transfer to ${receiverAccount.accountHolderName}`,
      counterparty: receiverAccount.accountHolderName,
      counterpartyAccount: receiverAccount.accountNumber,
      counterpartyBank: receiverAccount.bankName,
      status: transactionStatus,
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: isScheduled ? senderAccount.balance : senderAccount.balance,
      scheduledDate: isScheduled ? new Date(scheduledDate) : null,
      isRecurring: isRecurring || false,
      recurringType: recurringType || null
    });
    await debitTransaction.save({ session });

    const creditTransaction = new Transaction({
      userId: receiverAccount.userId,
      accountId: receiverAccount._id,
      transactionId: generateTransactionId(),
      amount: transferAmount,
      type: 'CREDIT',
      description: description || `Transfer from ${senderAccount.accountHolderName}`,
      counterparty: senderAccount.accountHolderName,
      counterpartyAccount: senderAccount.accountNumber,
      counterpartyBank: senderAccount.bankName,
      status: transactionStatus,
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: isScheduled ? receiverAccount.balance : receiverAccount.balance,
      scheduledDate: isScheduled ? new Date(scheduledDate) : null,
      isRecurring: isRecurring || false,
      recurringType: recurringType || null
    });
    await creditTransaction.save({ session });

    // Create notifications
    const senderNotification = new Notification({
      userId: req.userId,
      notificationId: `NOTIF${Date.now()}`,
      title: isScheduled ? 'Transfer Scheduled' : 'Transfer Successful',
      message: isScheduled 
        ? `₹${transferAmount.toLocaleString('en-IN')} scheduled to ${receiverAccount.accountHolderName} on ${new Date(scheduledDate).toLocaleDateString()}`
        : `₹${transferAmount.toLocaleString('en-IN')} transferred to ${receiverAccount.accountHolderName}`,
      type: 'TRANSACTION',
      data: { transactionId: debitTransaction.transactionId, scheduled: isScheduled }
    });
    await senderNotification.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: isScheduled ? 'Transfer scheduled successfully' : 'Transfer successful',
      transaction: debitTransaction,
      newBalance: isScheduled ? senderAccount.balance : senderAccount.balance,
      scheduled: isScheduled,
      scheduledDate: scheduledDate
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

// ==================== ACCOUNT TO ACCOUNT TRANSFER WITH ACCOUNT NUMBER ====================
router.post('/by-account-number', auth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { 
      toAccountNumber, 
      amount, 
      description,
      message 
    } = req.body;

    // Validate input
    if (!toAccountNumber || !amount) {
      throw new Error('Account number and amount are required');
    }

    const senderAccount = await BankAccount.findOne({ userId: req.userId }).session(session);
    if (!senderAccount) {
      throw new Error('Sender account not found');
    }

    const transferAmount = parseFloat(amount);
    if (transferAmount > senderAccount.balance) {
      throw new Error('Insufficient balance');
    }

    // Find receiver by account number only (more flexible)
    const receiverAccount = await BankAccount.findOne({ 
      accountNumber: toAccountNumber
    }).session(session);

    if (!receiverAccount) {
      throw new Error('Receiver account not found. Please check the account number.');
    }

    // Prevent self-transfer
    if (receiverAccount.userId.toString() === senderAccount.userId.toString()) {
      throw new Error('Cannot transfer to your own account');
    }

    // Process transfer
    senderAccount.balance -= transferAmount;
    await senderAccount.save({ session });

    receiverAccount.balance += transferAmount;
    await receiverAccount.save({ session });

    const debitTransaction = new Transaction({
      userId: req.userId,
      accountId: senderAccount._id,
      transactionId: generateTransactionId(),
      amount: transferAmount,
      type: 'DEBIT',
      description: description || `Transfer to ${receiverAccount.accountHolderName}`,
      counterparty: receiverAccount.accountHolderName,
      counterpartyAccount: receiverAccount.accountNumber,
      counterpartyBank: receiverAccount.bankName,
      status: 'SUCCESS',
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: senderAccount.balance,
      transferMessage: message || null
    });
    await debitTransaction.save({ session });

    const creditTransaction = new Transaction({
      userId: receiverAccount.userId,
      accountId: receiverAccount._id,
      transactionId: generateTransactionId(),
      amount: transferAmount,
      type: 'CREDIT',
      description: description || `Transfer from ${senderAccount.accountHolderName}`,
      counterparty: senderAccount.accountHolderName,
      counterpartyAccount: senderAccount.accountNumber,
      counterpartyBank: senderAccount.bankName,
      status: 'SUCCESS',
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: receiverAccount.balance,
      transferMessage: message || null
    });
    await creditTransaction.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: 'Transfer successful',
      transaction: debitTransaction,
      newBalance: senderAccount.balance,
      receiver: {
        name: receiverAccount.accountHolderName,
        bank: receiverAccount.bankName,
        accountNumber: receiverAccount.accountNumber
      }
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

// ==================== WITHDRAWAL ====================
router.post('/withdraw', auth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, description, withdrawalMethod } = req.body;

    const account = await BankAccount.findOne({ userId: req.userId }).session(session);
    if (!account) {
      throw new Error('Account not found');
    }

    const withdrawalAmount = parseFloat(amount);
    if (withdrawalAmount > account.balance) {
      throw new Error('Insufficient balance');
    }

    // Check daily withdrawal limit (default: ₹50,000)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const todayWithdrawals = await Transaction.find({
      userId: req.userId,
      type: 'DEBIT',
      description: { $regex: /withdrawal/i },
      date: { $gte: today }
    }).session(session);

    const totalWithdrawnToday = todayWithdrawals.reduce((sum, t) => sum + t.amount, 0);
    const dailyLimit = 50000; // ₹50,000 daily limit
    
    if (totalWithdrawnToday + withdrawalAmount > dailyLimit) {
      throw new Error(`Daily withdrawal limit exceeded. Remaining limit: ₹${(dailyLimit - totalWithdrawnToday).toLocaleString('en-IN')}`);
    }

    // Process withdrawal
    account.balance -= withdrawalAmount;
    await account.save({ session });

    const transaction = new Transaction({
      userId: req.userId,
      accountId: account._id,
      transactionId: generateTransactionId(),
      amount: withdrawalAmount,
      type: 'DEBIT',
      description: description || `Withdrawal ${withdrawalMethod ? `via ${withdrawalMethod}` : ''}`,
      counterparty: 'Self Withdrawal',
      counterpartyAccount: account.accountNumber,
      counterpartyBank: account.bankName,
      status: 'SUCCESS',
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: account.balance
    });
    await transaction.save({ session });

    const notification = new Notification({
      userId: req.userId,
      notificationId: `NOTIF${Date.now()}`,
      title: 'Withdrawal Successful',
      message: `₹${withdrawalAmount.toLocaleString('en-IN')} withdrawn from your account`,
      type: 'TRANSACTION',
      data: { transactionId: transaction.transactionId }
    });
    await notification.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: 'Withdrawal successful',
      transaction: transaction,
      newBalance: account.balance
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

// ==================== GET PENDING TRANSACTIONS ====================
router.get('/pending', auth, async (req, res, next) => {
  try {
    const pendingTransactions = await Transaction.find({
      userId: req.userId,
      status: 'PENDING'
    }).sort({ scheduledDate: 1, date: 1 });

    res.json({
      success: true,
      pendingCount: pendingTransactions.length,
      transactions: pendingTransactions
    });
  } catch (error) {
    next(error);
  }
});

// ==================== RETRY PENDING TRANSACTION ====================
router.post('/retry/:transactionId', auth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const pendingTransaction = await Transaction.findOne({
      transactionId: req.params.transactionId,
      userId: req.userId,
      status: 'PENDING'
    }).session(session);

    if (!pendingTransaction) {
      throw new Error('Pending transaction not found');
    }

    const senderAccount = await BankAccount.findOne({ userId: req.userId }).session(session);
    const receiverAccount = await BankAccount.findOne({ 
      accountNumber: pendingTransaction.counterpartyAccount
    }).session(session);

    if (!senderAccount || !receiverAccount) {
      throw new Error('Account not found');
    }

    if (pendingTransaction.amount > senderAccount.balance) {
      throw new Error('Insufficient balance to process pending transaction');
    }

    // Process the pending transaction
    senderAccount.balance -= pendingTransaction.amount;
    await senderAccount.save({ session });

    receiverAccount.balance += pendingTransaction.amount;
    await receiverAccount.save({ session });

    pendingTransaction.status = 'SUCCESS';
    pendingTransaction.balanceAfterTransaction = senderAccount.balance;
    await pendingTransaction.save({ session });

    await session.commitTransaction();

    res.json({
      success: true,
      message: 'Pending transaction processed successfully',
      transaction: pendingTransaction,
      newBalance: senderAccount.balance
    });
  } catch (error) {
    await session.abortTransaction();
    next(error);
  } finally {
    session.endSession();
  }
});

// ==================== GET TRANSFER HISTORY ====================
router.get('/history', auth, async (req, res, next) => {
  try {
    const { page = 1, limit = 20, type, status, from, to } = req.query;

    let query = { userId: req.userId };
    if (type) query.type = type;
    if (status) query.status = status;
    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) query.date.$lte = new Date(to);
    }

    const transactions = await Transaction.find(query)
      .sort({ date: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments(query);
    
    // Calculate totals
    const totalSent = transactions
      .filter(t => t.type === 'DEBIT' && t.status === 'SUCCESS')
      .reduce((sum, t) => sum + t.amount, 0);
      
    const totalReceived = transactions
      .filter(t => t.type === 'CREDIT' && t.status === 'SUCCESS')
      .reduce((sum, t) => sum + t.amount, 0);

    res.json({
      success: true,
      transactions,
      totals: {
        sent: totalSent,
        received: totalReceived,
        net: totalReceived - totalSent
      },
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ==================== ADMIN: ADD FAKE AMOUNT ====================
router.post('/admin/add-fake-amount', auth, async (req, res, next) => {
  try {
    const { userId, amount, reason } = req.body;
    
    // In production, this should have admin verification
    // For simulation, we'll allow adding to any account
    
    const account = await BankAccount.findOne({ userId: userId || req.userId });
    if (!account) {
      return res.status(404).json({ message: 'Account not found' });
    }

    const addAmount = parseFloat(amount);
    account.balance += addAmount;
    await account.save();

    const transaction = new Transaction({
      userId: account.userId,
      accountId: account._id,
      transactionId: generateTransactionId(),
      amount: addAmount,
      type: 'CREDIT',
      description: reason || 'Admin Credit (Simulation)',
      counterparty: 'Bank Administration',
      counterpartyAccount: 'ADMIN',
      counterpartyBank: account.bankName,
      status: 'SUCCESS',
      referenceNumber: generateReferenceNumber(),
      balanceAfterTransaction: account.balance
    });
    await transaction.save();

    res.json({
      success: true,
      message: `₹${addAmount.toLocaleString('en-IN')} added to account`,
      newBalance: account.balance,
      transaction
    });
  } catch (error) {
    next(error);
  }
});

// ==================== GET ACCOUNT DETAILS BY ACCOUNT NUMBER ====================
router.get('/verify-account/:accountNumber', auth, async (req, res, next) => {
  try {
    const { accountNumber } = req.params;
    
    const account = await BankAccount.findOne({ accountNumber })
      .select('accountHolderName bankName ifscCode');
    
    if (!account) {
      return res.status(404).json({ 
        success: false, 
        message: 'Account not found' 
      });
    }

    res.json({
      success: true,
      account: {
        name: account.accountHolderName,
        bankName: account.bankName,
        ifscCode: account.ifscCode
      }
    });
  } catch (error) {
    next(error);
  }
});

export default router;