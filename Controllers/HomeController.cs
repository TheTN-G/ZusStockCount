using System.Diagnostics;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ZusStoreStock.Models;

namespace ZusStoreStock.Controllers;

[Authorize]
public class HomeController : Controller
{
    // The stock list is the home page.
    public IActionResult Index() => RedirectToAction("Index", "Stock");

    [AllowAnonymous]
    [IgnoreAntiforgeryToken]
    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }
}