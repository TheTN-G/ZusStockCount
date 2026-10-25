using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using ZusStoreStock.Data;
using ZusStoreStock.Models;

namespace ZusStoreStock.Controllers;

public class AccountController : Controller
{
    private static readonly Regex UsernameRule = new(@"^[A-Za-z0-9._-]{3,50}$");

    private readonly ZusStoreStockContext _context;
    private readonly IConfiguration _config;
    private readonly PasswordHasher<User> _hasher = new();

    public AccountController(ZusStoreStockContext context, IConfiguration config)
    {
        _context = context;
        _config = config;
    }

    // Code that every staff member must type to create their own account. Empty = sign-up closed.
    private string StoreCode => (_config["Registration:StoreCode"] ?? "").Trim();

    // Extra key that only supervisors get from the admin. Empty = Supervisor sign-up closed.
    private string SupervisorKey => (_config["Registration:SupervisorKey"] ?? "").Trim();

    // ---------- Log in ----------
    [AllowAnonymous, HttpGet]
    public async Task<IActionResult> Login(string? returnUrl)
    {
        if (User.Identity?.IsAuthenticated == true) return RedirectToAction("Index", "Home");

        // No users yet: the very first thing to do is create the Admin.
        if (!await _context.Users.AnyAsync()) return RedirectToAction(nameof(Setup));

        ViewBag.ReturnUrl = returnUrl;
        ViewBag.SignupOpen = StoreCode.Length > 0;
        return View();
    }

    [AllowAnonymous, HttpPost, EnableRateLimiting("login")]
    public async Task<IActionResult> Login(string? username, string? password, string? returnUrl)
    {
        var name = Clean(username);

        if (name.Length == 0 || string.IsNullOrEmpty(password))
        {
            TempData["Error"] = "Please enter your username and password.";
            return RedirectToAction(nameof(Login), new { returnUrl });
        }

        var user = await _context.Users.FirstOrDefaultAsync(u => u.Username == name);
        if (user == null || _hasher.VerifyHashedPassword(user, user.PasswordHash, password) == PasswordVerificationResult.Failed)
        {
            TempData["Error"] = "Wrong username or password. Please try again.";
            return RedirectToAction(nameof(Login), new { returnUrl });
        }

        await SignInAsync(user);
        TempData["Msg"] = $"Welcome, {DisplayName(user)}!";

        return Url.IsLocalUrl(returnUrl) ? Redirect(returnUrl!) : RedirectToAction("Index", "Home");
    }

    [HttpPost]
    public async Task<IActionResult> Logout()
    {
        await HttpContext.SignOutAsync();
        TempData["Msg"] = "You have been logged out.";
        return RedirectToAction(nameof(Login));
    }

    [AllowAnonymous]
    public IActionResult AccessDenied() => View();

    // ---------- First-time setup: creates the first Admin (only works while there are no users) ----------
    [AllowAnonymous, HttpGet]
    public async Task<IActionResult> Setup()
    {
        if (await _context.Users.AnyAsync()) return RedirectToAction(nameof(Login));
        return View();
    }

    [AllowAnonymous, HttpPost, EnableRateLimiting("login")]
    public async Task<IActionResult> Setup(string? username, string? fullName, string? outlet, string? password, string? confirmPassword)
    {
        if (await _context.Users.AnyAsync())
        {
            TempData["Error"] = "Setup is already done. Please log in.";
            return RedirectToAction(nameof(Login));
        }

        username = Clean(username);
        fullName = Clean(fullName);
        outlet = Clean(outlet);

        var error = await ValidateNewUserAsync(username, fullName, outlet, password, confirmPassword);
        if (error != null)
        {
            KeepForm(username, fullName, outlet, "Admin");
            TempData["Error"] = error;
            return View();
        }

        await CreateUserAsync(username, fullName, outlet, "Admin", password!);

        TempData["Msg"] = $"Admin account '{username}' created. Please log in.";
        return RedirectToAction(nameof(Login));
    }

    // ---------- Staff / Supervisor create their own account ----------
    [AllowAnonymous, HttpGet]
    public async Task<IActionResult> Signup()
    {
        if (User.Identity?.IsAuthenticated == true) return RedirectToAction("Index", "Home");
        if (!await _context.Users.AnyAsync()) return RedirectToAction(nameof(Setup));

        if (StoreCode.Length == 0)
        {
            TempData["Error"] = "Account sign-up is closed. Please ask an admin to create your account.";
            return RedirectToAction(nameof(Login));
        }

        ViewBag.SupervisorOpen = SupervisorKey.Length > 0;
        return View();
    }

    [AllowAnonymous, HttpPost, EnableRateLimiting("login")]
    public async Task<IActionResult> Signup(string? username, string? fullName, string? outlet, string? role,
                                            string? storeCode, string? supervisorKey,
                                            string? password, string? confirmPassword)
    {
        if (User.Identity?.IsAuthenticated == true) return RedirectToAction("Index", "Home");

        if (StoreCode.Length == 0)
        {
            TempData["Error"] = "Account sign-up is closed. Please ask an admin to create your account.";
            return RedirectToAction(nameof(Login));
        }

        username = Clean(username);
        fullName = Clean(fullName);
        outlet = Clean(outlet);
        var wantsSupervisor = role == "Supervisor";
        var chosenRole = wantsSupervisor ? "Supervisor" : "Staff";   // sign-up can never make an Admin

        if (!CodeMatches(storeCode, StoreCode))
        {
            KeepForm(username, fullName, outlet, chosenRole);
            TempData["Error"] = "The store code is not correct. Please ask your admin for the right code.";
            return View();
        }

        if (wantsSupervisor)
        {
            if (SupervisorKey.Length == 0)
            {
                KeepForm(username, fullName, outlet, "Staff");
                TempData["Error"] = "Supervisor sign-up is closed. Please ask an admin to create your Supervisor account.";
                return View();
            }
            if (!CodeMatches(supervisorKey, SupervisorKey))
            {
                KeepForm(username, fullName, outlet, chosenRole);
                TempData["Error"] = "The supervisor key is not correct. Please ask an admin for the key.";
                return View();
            }
        }

        var error = await ValidateNewUserAsync(username, fullName, outlet, password, confirmPassword);
        if (error != null)
        {
            KeepForm(username, fullName, outlet, chosenRole);
            TempData["Error"] = error;
            return View();
        }

        var user = await CreateUserAsync(username, fullName, outlet, chosenRole, password!);

        await SignInAsync(user);
        TempData["Msg"] = $"Account created. Welcome, {DisplayName(user)}!";
        return RedirectToAction("Index", "Home");
    }

    // ---------- Admin creates any account (Staff, Supervisor or Admin) ----------
    [Authorize(Roles = "Admin"), HttpGet]
    public IActionResult Register() => View();

    [Authorize(Roles = "Admin"), HttpPost]
    public async Task<IActionResult> Register(string? username, string? fullName, string? outlet, string? role, string? password)
    {
        username = Clean(username);
        fullName = Clean(fullName);
        outlet = Clean(outlet);
        var chosenRole = role is "Supervisor" or "Admin" ? role : "Staff";

        var error = await ValidateNewUserAsync(username, fullName, outlet, password, password);
        if (error != null)
        {
            KeepForm(username, fullName, outlet, chosenRole);
            TempData["Error"] = error;
            return View();
        }

        await CreateUserAsync(username, fullName, outlet, chosenRole, password!);

        TempData["Msg"] = $"Account '{username}' ({chosenRole}) created successfully.";
        return RedirectToAction("Index", "Home");
    }

    // ---------- Helpers ----------
    private static string Clean(string? value) => (value ?? "").Trim();

    private static string DisplayName(User user) =>
        string.IsNullOrWhiteSpace(user.FullName) ? user.Username : user.FullName;

    private static bool CodeMatches(string? entered, string expected)
    {
        var a = Encoding.UTF8.GetBytes(Clean(entered));
        var b = Encoding.UTF8.GetBytes(expected);
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    private void KeepForm(string username, string fullName, string outlet, string role)
    {
        ViewBag.Username = username;
        ViewBag.FullName = fullName;
        ViewBag.Outlet = outlet;
        ViewBag.Role = role;
        ViewBag.SupervisorOpen = SupervisorKey.Length > 0;
    }

    private async Task<string?> ValidateNewUserAsync(string username, string fullName, string outlet,
                                                     string? password, string? confirmPassword)
    {
        if (!UsernameRule.IsMatch(username))
            return "Username must be 3 to 50 characters: letters, numbers, dot, dash or underscore only (no spaces).";
        if (fullName.Length == 0)
            return "Please enter your full name.";
        if (fullName.Length > 100 || outlet.Length > 100)
            return "Full name and outlet must be 100 characters or less.";
        if ((password ?? "").Length < 8)
            return "Password needs at least 8 characters.";
        if (password != confirmPassword)
            return "The two passwords do not match.";
        if (await _context.Users.AnyAsync(u => u.Username == username))
            return $"Username '{username}' is already taken. Please choose another one.";
        return null;
    }

    private async Task<User> CreateUserAsync(string username, string fullName, string outlet, string role, string password)
    {
        var user = new User
        {
            Username = username,
            FullName = fullName,
            Outlet = outlet,
            Role = role
        };
        user.PasswordHash = _hasher.HashPassword(user, password);

        _context.Users.Add(user);
        await _context.SaveChangesAsync();
        return user;
    }

    private async Task SignInAsync(User user)
    {
        var identity = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, user.Username),
            new Claim(ClaimTypes.GivenName, DisplayName(user)),
            new Claim(ClaimTypes.Role, user.Role)
        }, CookieAuthenticationDefaults.AuthenticationScheme);

        await HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, new ClaimsPrincipal(identity));
    }
}