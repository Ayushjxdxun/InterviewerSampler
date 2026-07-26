
import asyncHandler from 'express-async-handler';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const getNormalizedEmail = (email) => (email || '').trim().toLowerCase();
const getJwtSecret = () => process.env.JWT_SECRET || 'dev-secret-change-me';
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

const generateToken = (id) => {
    return jwt.sign({ id }, getJwtSecret(), {
        expiresIn: '1d',
    });
};

const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    const normalizedEmail = getNormalizedEmail(email);

    if (!name || !normalizedEmail || !password) {
        res.status(400);
        throw new Error('Please enter all required fields (Name, Email, Password).');
    }

    const userExists = await User.findOne({ email: normalizedEmail });
    if (userExists) {
        res.status(400);
        throw new Error('User already exists with this email address.');
    }

    const user = await User.create({
        name: name.trim(),
        email: normalizedEmail,
        password,
    });

    if (user) {
        res.status(201).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id),
        });
    } else {
        res.status(400);
        throw new Error('Invalid user data provided.');
    }
});


const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = getNormalizedEmail(email);

    const user = await User.findOne({ email: normalizedEmail });

    if (user && (await user.matchPassword(password))) {
        res.json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id),
        });
    } else {
        res.status(401);
        throw new Error('Invalid email or password.');
    }
});

const googleLogin = asyncHandler(async (req, res) => {
    const { token } = req.body;

    if (!googleClient || !process.env.GOOGLE_CLIENT_ID) {
        res.status(503);
        throw new Error('Google authentication is not configured.');
    }

    const ticket = await googleClient.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email_verified, name, email, sub: googleId } = payload;

    if (!email_verified) {
        res.status(401);
        throw new Error('Google email not verified. Login failed.');
    }

    const normalizedEmail = getNormalizedEmail(email);
    let user = await User.findOne({ email: normalizedEmail });

    if (user) {
        if (!user.googleId) {
            user.googleId = googleId;
            user.name = user.name || name;
            user.email = normalizedEmail;
            await user.save();
        }
    } else {
        user = await User.create({
            name: name?.trim() || normalizedEmail.split('@')[0],
            email: normalizedEmail,
            googleId,
            password: null,
        });
    }

    if (user) {
        res.status(200).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id),
        });
    } else {
        res.status(400);
        throw new Error('Could not process user creation or login via Google.');
    }
});


const getUserProfile = asyncHandler(async (req, res) => {
   
    if (req.user) {
        res.json({
            _id: req.user._id,
            name: req.user.name,
            email: req.user.email,
            preferredRole: req.user.preferredRole,
            token: generateToken(req.user._id),
        });
    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

const updateUserProfile = asyncHandler(async (req, res) => {
    if (req.user) {
        const user = await User.findById(req.user._id);
        if (!user) {
            res.status(404);
            throw new Error('User not found');
        }

        const newName = req.body.name?.trim();
        const newEmail = req.body.email ? getNormalizedEmail(req.body.email) : user.email;

        if (newEmail !== user.email && await User.exists({ email: newEmail, _id: { $ne: user._id } })) {
            res.status(400);
            throw new Error('Another user already uses that email address.');
        }

        user.name = newName || user.name;
        user.email = newEmail;
        user.preferredRole = req.body.preferredRole || user.preferredRole;
        if (req.body.password) {
            user.password = req.body.password;
        }
        await user.save();

        res.status(200).json({
            _id: user._id,
            name: user.name,
            email: user.email,
            preferredRole: user.preferredRole,
            token: generateToken(user._id),
        });
    } else {
        res.status(404);
        throw new Error('User not found');
    }
});

export { registerUser, loginUser, googleLogin,getUserProfile,updateUserProfile };